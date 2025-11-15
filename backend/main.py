from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Literal, List, Dict, Any
import os
import json

import google.generativeai as genai

# ===========================
# GEMINI CLIENT SETUP
# ===========================
# Make sure you set:
#   export GEMINI_API_KEY="AIza..."
genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
GEMINI_MODEL_NAME = "gemini-2.5-flash"
model = genai.GenerativeModel(
    GEMINI_MODEL_NAME,
    generation_config={
        # Ask Gemini to return raw JSON, not prose/markdown
        "response_mime_type": "application/json",
        "temperature": 0.0,
    },
)

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
        # remove ```json and ``` fences
        text = text.replace("```json", "").replace("```", "").strip()

    # As a backup: take from first '{' to last '}'
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start:end+1].strip()

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
    # We keep "youtube" as an option but just return a placeholder for now
    mode: Literal["text", "youtube"]
    content: str

@app.get("/")
def health():
    return {"status": "ok"}


# ===========================
# COUNCIL OF GEMINI JUDGES
# ===========================

# Three different "personas" looking at the same text
JUDGE_ROLES = [
    "a university professor of logic and critical thinking",
    "an investigative journalist specializing in fact-checking misinformation",
    "a researcher in AI safety and online persuasion analysis",
]

# Shared JSON schema + instructions for every judge
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
  "ai_generated_likelihood": "low" | "medium" | "high",
  "ai_explanation": "string"
}

For each fallacy:
- Provide an academically grounded explanation.
- Provide a counterargument consistent with peer-reviewed research or scientific consensus.
- Provide a realistic citation (authors, year, journal or source).
If no fallacies are found, use an empty list for "fallacies".
Do NOT include any text outside the JSON.
"""


def run_single_judge(role_description: str, text: str) -> Dict[str, Any]:
    """
    Run ONE Gemini judge with a given role/persona on the text.
    Returns a dict matching the schema, or a safe fallback if JSON parsing fails.
    """
    prompt = (
        f"You are {role_description}.\n"
        "Analyze the following text for logical fallacies, credibility, "
        "and likelihood of being AI-generated.\n"
        + BASE_JSON_SCHEMA_TEXT
        + "\n\nText to analyze:\n\n"
        + text
    )

    response = model.generate_content(prompt)
    model_output = response.text or ""

    try:
        result = json.loads(model_output)
    except Exception:
        # Fallback so the rest of the pipeline doesn't crash
        result = {
            "credibility_score": 50,
            "notes": "Model did not return valid JSON. Raw output attached.",
            "fallacies": [],
            "ai_generated_likelihood": "medium",
            "ai_explanation": "Parsing error for this judge.",
            "raw_model_output": model_output,
        }

    return result


def aggregate_council_results(judge_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Combine all judge outputs into a single final verdict.
    - credibility_score = average of judges
    - ai_generated_likelihood = average vote over {low, medium, high}
    - fallacies = union of all fallacies (dedupe by type+quote)
    - notes, ai_explanation = concatenated summaries from all judges
    """
    # --- credibility_score average ---
    scores = [
        r.get("credibility_score", 50)
        for r in judge_results
        if isinstance(r.get("credibility_score", None), (int, float))
    ]
    final_score = int(round(sum(scores) / len(scores))) if scores else 50

    # --- ai_generated_likelihood vote average ---
    label_to_int = {"low": 0, "medium": 1, "high": 2}
    int_to_label = {0: "low", 1: "medium", 2: "high"}

    votes = []
    for r in judge_results:
        label = str(r.get("ai_generated_likelihood", "medium")).lower()
        if label in label_to_int:
            votes.append(label_to_int[label])

    if votes:
        avg_vote = round(sum(votes) / len(votes))
        final_ai_likelihood = int_to_label.get(avg_vote, "medium")
    else:
        final_ai_likelihood = "medium"

    # --- merge fallacies, dedupe by (type, quote) ---
    seen = set()
    merged_fallacies = []
    for r in judge_results:
        fallacies = r.get("fallacies", [])
        if not isinstance(fallacies, list):
            continue
        for f in fallacies:
            if not isinstance(f, dict):
                continue
            key = (f.get("type", ""), f.get("quote", ""))
            if key in seen:
                continue
            seen.add(key)
            merged_fallacies.append({
                "type": f.get("type", "Unknown"),
                "quote": f.get("quote", ""),
                "explanation": f.get("explanation", ""),
                "counterexample": f.get("counterexample", ""),
                "peer_reviewed_counterargument": f.get("peer_reviewed_counterargument", ""),
                "citation": f.get("citation", ""),
            })

    # --- combine notes from judges ---
    notes_parts = []
    for i, r in enumerate(judge_results):
        label = f"Judge {i+1}"
        n = r.get("notes", "")
        if n:
            notes_parts.append(f"{label}: {n}")
    combined_notes = " | ".join(notes_parts) if notes_parts else "Council summary generated."

    # --- combine ai_explanation from judges ---
    ai_expl_parts = []
    for i, r in enumerate(judge_results):
        label = f"Judge {i+1}"
        expl = r.get("ai_explanation", "")
        if expl:
            ai_expl_parts.append(f"{label}: {expl}")
    combined_ai_expl = " | ".join(ai_expl_parts) if ai_expl_parts else "Council consensus explanation."

    return {
        "credibility_score": final_score,
        "notes": combined_notes,
        "fallacies": merged_fallacies,
        "ai_generated_likelihood": final_ai_likelihood,
        "ai_explanation": combined_ai_expl,
        "council": judge_results,  # raw per-judge details (for debugging / future UI)
    }


# ===========================
# MAIN ENDPOINT
# ===========================

@app.post("/analyze")
async def analyze(request: AnalyzeRequest):
    """
    Main endpoint used by the extension.

    - mode = "text": analyze raw content
    - mode = "youtube": currently not implemented; returns a friendly message
    """
    raw_content = request.content.strip()

    if not raw_content:
        return {
            "credibility_score": 0,
            "notes": "No input provided.",
            "fallacies": [],
            "ai_generated_likelihood": "low",
            "ai_explanation": "No content to analyze.",
        }

    # For now, we only support text mode; YouTube will be implemented later.
    if request.mode == "youtube":
        return {
            "credibility_score": 0,
            "notes": "YouTube analysis is not implemented yet. Please switch to Text mode.",
            "fallacies": [],
            "ai_generated_likelihood": "medium",
            "ai_explanation": "This is a placeholder; your teammates will add transcript support here.",
        }

    # Text mode: analyze the text directly
    text = raw_content

    # Truncate very long content to keep prompts reasonable
    if len(text) > 4000:
        text = text[:4000]

    try:
        # Run all judges sequentially
        judge_results: List[Dict[str, Any]] = []
        for role in JUDGE_ROLES:
            jr = run_single_judge(role, text)
            judge_results.append(jr)

        final_result = aggregate_council_results(judge_results)
        return final_result

    except Exception as e:
        # Fail-safe response so your extension never breaks
        return {
            "credibility_score": 50,
            "notes": f"Error running council: {str(e)}",
            "fallacies": [],
            "ai_generated_likelihood": "medium",
            "ai_explanation": "Backend error, using fallback.",
        }
