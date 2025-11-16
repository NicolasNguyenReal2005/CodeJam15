from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
import os
import json

import google.generativeai as genai
from groq import Groq

# OpenAI client (new SDK)
from openai import OpenAI
client = OpenAI()

# ===========================
# API KEYS / CLIENTS
# ===========================
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

# --- Gemini ---
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    GEMINI_MODEL_NAME = "gemini-2.5-flash"
    gemini_model = genai.GenerativeModel(
        GEMINI_MODEL_NAME,
        generation_config={
            # Ask Gemini to return raw JSON, not prose/markdown
            "response_mime_type": "application/json",
            "temperature": 0.0,
        },
    )
else:
    gemini_model = None

# --- Groq ---
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# --- OpenAI ---
openai_client = OpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None


def extract_json_block(text: str) -> str:
    """
    Try to extract the JSON object from the model output.
    - Strips ```json ... ``` fences if present
    - Or grabs the substring from first '{' to last '}'.
    """
    if not text:
        return text

    # Remove markdown fences if present
    if "```" in text:
        text = text.replace("```json", "").replace("```", "").strip()

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1].strip()

    return text.strip()


# ===========================
# FASTAPI + CORS
# ===========================
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # fine for hackathon; restrict in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    # Only text mode now
    content: str


@app.get("/")
def health():
    return {"status": "ok"}


# ===========================
# SHARED JSON SCHEMA PROMPT
# ===========================

BASE_JSON_SCHEMA_TEXT = """
You MUST return ONLY valid JSON with this exact structure:

{
  "credibility_score": number 0-100,
  "notes": "short string",
  "fallacies": [
    {
      "type": "string",
      "quote": "string",
      "explanation": "string",
      "counterexample": "string",
      "peer_reviewed_counterargument": "string",
      "citation": "string"
    }
  ],
  "ai_explanation": "string"
}

For each fallacy:
- Provide an academically grounded explanation.
- Provide a counterargument consistent with peer-reviewed research or scientific consensus.
- Provide a realistic citation (authors, year, journal or source).
If no fallacies are found, use an empty list for "fallacies".
Do NOT include any text outside the JSON.
"""


# ===========================
# INDIVIDUAL JUDGES (OPENAI + GROQ)
# ===========================

def run_openai_judge(role_description: str, judge_name: str, text: str) -> Dict[str, Any]:
    """
    Judge #1 – OpenAI
    """
    if not openai_client:
        return {
            "provider": "openai",
            "name": judge_name,
            "credibility_score": 50,
            "notes": "OpenAI API key missing; this judge is inactive.",
            "fallacies": [],
            "ai_explanation": "Judge disabled due to missing API key.",
        }

    system_prompt = (
        f"You are {role_description}.\n"
        "Analyze the following text for logical fallacies and credibility of its claims. "
        "Keep it concise and precise.\n"
        + BASE_JSON_SCHEMA_TEXT
    )

    try:
        resp = openai_client.chat.completions.create(
            model="gpt-4o",  # you can change model here
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            temperature=0.0,
        )
        raw_output = resp.choices[0].message.content
        cleaned = extract_json_block(raw_output)
        result = json.loads(cleaned)
    except Exception as e:
        result = {
            "credibility_score": 50,
            "notes": f"OpenAI parsing/error: {e}",
            "fallacies": [],
            "ai_explanation": "Parsing error for this judge.",
            "raw_model_output": str(locals().get("raw_output", "")),
        }

    result["provider"] = "openai"
    result["name"] = judge_name
    return result


def run_groq_judge(model_name: str, judge_name: str, text: str) -> Dict[str, Any]:
    """
    Judge #2 – Groq
    """
    if not groq_client:
        return {
            "provider": "groq",
            "name": judge_name,
            "credibility_score": 50,
            "notes": "Groq API key missing; this judge is inactive.",
            "fallacies": [],
            "ai_explanation": "Judge disabled due to missing API key.",
        }

    system_prompt = (
        "You are a university professor of logic and critical thinking. "
        "You are an investigative journalist specializing in fact-checking online claims. "
        "You analyze text for logical fallacies and credibility. "
        "Provide enough information to educate the user while keeping it concise.\n"
        + BASE_JSON_SCHEMA_TEXT
    )

    try:
        resp = groq_client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            temperature=0.0,
        )
        raw_output = resp.choices[0].message.content
        cleaned = extract_json_block(raw_output)
        result = json.loads(cleaned)
    except Exception as e:
        result = {
            "credibility_score": 50,
            "notes": f"Groq parsing error: {e}",
            "fallacies": [],
            "ai_explanation": "Parsing error for this judge.",
            "raw_model_output": str(locals().get("raw_output", "")),
        }

    result["provider"] = "groq"
    result["name"] = judge_name
    return result


# ===========================
# GEMINI SUMMARY OF OPENAI + GROQ
# ===========================

def make_gemini_summary(judge_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Gemini reads the OpenAI + Groq judge outputs and produces
    a single fused verdict in the SAME JSON schema as BASE_JSON_SCHEMA_TEXT
    (without any AI-detection fields).
    """
    # If Gemini unavailable, fall back to a simple local fusion
    if not gemini_model:
        if not judge_results:
            return {
                "provider": "fallback",
                "name": "Local Fallback Summary",
                "credibility_score": 50,
                "notes": "No judges available; neutral fallback.",
                "fallacies": [],
                "ai_explanation": "No judge outputs available.",
            }

        # Simple average + merged fallacies as a fallback
        scores = [
            j.get("credibility_score", 50)
            for j in judge_results
            if isinstance(j.get("credibility_score"), (int, float))
        ]
        avg_score = int(round(sum(scores) / len(scores))) if scores else 50

        seen = set()
        merged_fallacies = []
        for j in judge_results:
            fallacies = j.get("fallacies", [])
            if not isinstance(fallacies, list):
                continue
            for f in fallacies:
                if not isinstance(f, dict):
                    continue
                key = (f.get("type", ""), f.get("quote", ""))
                if key in seen:
                    continue
                seen.add(key)
                merged_fallacies.append(f)

        explanation = (
            f"Fallback summary combining {len(judge_results)} judges. "
            f"Average credibility score is {avg_score}/100."
        )

        return {
            "provider": "fallback",
            "name": "Local Fallback Summary",
            "credibility_score": avg_score,
            "notes": "Fallback fusion of OpenAI and Groq when Gemini is unavailable.",
            "fallacies": merged_fallacies,
            "ai_explanation": explanation,
        }

    # Normal path: Gemini summarizes
    judges_json = json.dumps(judge_results, indent=2)

    prompt = f"""
You are an AI that summarizes the opinions of two expert judges (OpenAI and Groq).

You are given a JSON array of exactly TWO judge results who analyzed the same text.
Each element in the array has this shape:
- provider (e.g. "openai", "groq")
- name
- credibility_score
- fallacies
- ai_explanation
- notes
- possibly other fields

Your task:
1. Carefully read both judge outputs.
2. Identify common points (where they agree).
3. Identify important differences (where they disagree).
4. Produce a SINGLE fused verdict that:
   - Uses the SAME JSON schema as in BASE_JSON_SCHEMA_TEXT:
     {{
       "credibility_score": number 0-100,
       "notes": "short string",
       "fallacies": [
         {{
           "type": "string",
           "quote": "string",
           "explanation": "string",
           "counterexample": "string",
           "peer_reviewed_counterargument": "string",
           "citation": "string"
         }}
       ],
       "ai_explanation": "string"
     }}

Guidelines:
- "credibility_score" should be consistent with both judges' reasoning (e.g. average or weighted by confidence).
- "notes" should be a short, direct summary of the overall credibility.
- "fallacies" should merge the important fallacies identified by the judges without duplication.
- "ai_explanation" should explain, in 2–4 sentences, how you reconciled both judges' opinions.
- "counterexample", "peer_reviewed_counterargument", and "citation" fields in each fallacy should be taken from the judge that provided them, prioritizing completeness and academic rigor.
Return ONLY valid JSON in the above schema. Do not add extra fields.

Judges JSON:
{judges_json}
"""

    try:
        response = gemini_model.generate_content(prompt)
        raw_output = response.text or ""
        cleaned = extract_json_block(raw_output)
        result = json.loads(cleaned)
    except Exception as e:
        result = {
            "credibility_score": 50,
            "notes": f"Gemini summary error: {e}",
            "fallacies": [],
            "ai_explanation": "Gemini failed to summarize. Using neutral fallback.",
            "raw_model_output": str(locals().get("raw_output", "")),
        }

    # Optional metadata (not required by extension, but not harmful)
    result["provider"] = "gemini"
    result["name"] = "Gemini – Fused Verdict"
    return result


# ===========================
# MAIN ENDPOINT
# ===========================

@app.post("/analyze")
async def analyze(request: AnalyzeRequest):
    """
    Main endpoint used by the extension.
    Analyzes raw text content only.
    """
    raw_content = request.content.strip()

    if not raw_content:
        return {
            "credibility_score": 0,
            "notes": "No input provided.",
            "fallacies": [],
            "ai_explanation": "No content to analyze.",
        }

    text = raw_content

    # Truncate very long content to keep prompts reasonable
    if len(text) > 4000:
        text = text[:4000]

    try:
        # --- BACKEND ONLY: run the 2 main judges (OpenAI + Groq) ---
        judges: List[Dict[str, Any]] = []

        # Judge 1: OpenAI – Reasoning expert
        judges.append(
            run_openai_judge(
                role_description="a philosophy professor and expert in reasoning, epistemology, and critical analysis",
                judge_name="OpenAI – Reasoning Expert",
                text=text,
            )
        )

        # Judge 2: Groq – Investigative journalist / logic professor
        judges.append(
            run_groq_judge(
                model_name="llama-3.1-8b-instant",
                judge_name="Groq – Investigative Journalist",
                text=text,
            )
        )

        # --- FINAL VERDICT: Gemini summarizes OpenAI + Groq ---
        final_verdict = make_gemini_summary(judges)

        # --- OUTPUT ONLY THE FINAL VERDICT TO THE EXTENSION ---
        return {
            "credibility_score": final_verdict["credibility_score"],
            "notes": final_verdict["notes"],
            "fallacies": final_verdict["fallacies"],
            "ai_explanation": final_verdict["ai_explanation"],
            # optional metadata
            "provider": final_verdict.get("provider", "gemini"),
            "judge_name": final_verdict.get("name", "Gemini – Fused Verdict"),
        }

    except Exception as e:
        # Fail-safe response so your extension never breaks
        return {
            "credibility_score": 50,
            "notes": f"Error running judges: {str(e)}",
            "fallacies": [],
            "ai_explanation": "Backend error, using fallback.",
        }
