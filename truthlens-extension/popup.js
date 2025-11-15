const analyzeBtn = document.getElementById("analyzeBtn");
const inputField = document.getElementById("inputField");
const useSelectionToggle = document.getElementById("useSelectionToggle");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

const STORAGE_PREFIX = "analysis_";  // key prefix for chrome.storage

function getSelectedMode() {
  const radios = document.querySelectorAll('input[name="mode"]');
  for (const r of radios) {
    if (r.checked) return r.value;
  }
  return "text";
}

function setLoading(isLoading) {
  analyzeBtn.disabled = isLoading;
  if (useSelectionToggle) useSelectionToggle.disabled = isLoading;
  statusEl.textContent = isLoading ? "Analyzing..." : "";
}

/* ===========================
   STORAGE HELPERS
   =========================== */

function saveAnalysis(mode, content, data) {
  // Save analysis per active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    const tabId = tabs[0].id;
    const key = STORAGE_PREFIX + tabId;

    const payload = {
      mode,
      content,
      data,
      timestamp: Date.now()
    };

    chrome.storage.local.set({ [key]: payload });
  });
}

function restoreAnalysisForCurrentTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) return;
    const tabId = tabs[0].id;
    const key = STORAGE_PREFIX + tabId;

    chrome.storage.local.get(key, (items) => {
      const saved = items[key];
      if (!saved) return;

      // Restore mode (text / youtube)
      const radios = document.querySelectorAll('input[name="mode"]');
      radios.forEach((r) => {
        r.checked = (r.value === saved.mode);
      });

      // Restore text
      if (saved.content) {
        inputField.value = saved.content;
      }

      // Restore results
      if (saved.data) {
        renderResults(saved.data);
        statusEl.textContent = "Loaded previous analysis for this page.";
      }
    });
  });
}

/* ===========================
   RENDER RESULTS
   =========================== */

function renderResults(data) {
  resultsEl.innerHTML = "";

  if (!data) {
    resultsEl.textContent = "No results.";
    return;
  }

  const council = Array.isArray(data.council) ? data.council : [];

  // ---- Credibility card ----
  if (typeof data.credibility_score !== "undefined") {
    const scoreCard = document.createElement("div");
    scoreCard.className = "result-card";

    // Per-judge notes
    let judgeNotesHtml = "";
    if (council.length) {
      judgeNotesHtml =
        `<div class="judge-notes-block">` +
        council
          .map((judge, idx) => {
            const note = judge.notes || "";
            if (!note) return "";
            return `
              <div class="judge-note">
                <div class="judge-title">Judge ${idx + 1}</div>
                <div>${note}</div>
              </div>
            `;
          })
          .join("") +
        `</div>`;
    }

    scoreCard.innerHTML = `
      <h3>Credibility Score</h3>
      <div><span class="result-label">Score:</span> ${data.credibility_score}/100</div>
      ${
        judgeNotesHtml
          ? judgeNotesHtml
          : data.notes
          ? `<div><span class="result-label">Notes:</span> ${data.notes}</div>`
          : ""
      }
    `;
    resultsEl.appendChild(scoreCard);
  }

  // ---- Fallacies ----
  if (Array.isArray(data.fallacies) && data.fallacies.length > 0) {
    data.fallacies.forEach((f) => {
      const card = document.createElement("div");
      card.className = "result-card";
      card.innerHTML = `
        <h3>${f.type || "Fallacy"}</h3>
        ${f.quote ? `<div><span class="result-label">Quote:</span> "${f.quote}"</div>` : ""}
        ${f.explanation ? `<div><span class="result-label">Explanation:</span> ${f.explanation}</div>` : ""}
        ${f.counterexample ? `<div><span class="result-label">Counterexample:</span> ${f.counterexample}</div>` : ""}
      `;
      resultsEl.appendChild(card);
    });
  }

  // ---- AI-generated assessment ----
  if (data.ai_generated_likelihood) {
    const aiCard = document.createElement("div");
    aiCard.className = "result-card";

    let aiByJudgeHtml = "";
    if (council.length) {
      aiByJudgeHtml =
        `<div class="judge-notes-block">` +
        council
          .map((judge, idx) => {
            const expl = judge.ai_explanation || "";
            if (!expl) return "";
            return `
              <div class="judge-note">
                <div class="judge-title">Judge ${idx + 1}</div>
                <div>${expl}</div>
              </div>
            `;
          })
          .join("") +
        `</div>`;
    }

    aiCard.innerHTML = `
      <h3>AI-Generated Assessment</h3>
      <div><span class="result-label">Likelihood:</span> ${data.ai_generated_likelihood}</div>
      ${
        aiByJudgeHtml
          ? aiByJudgeHtml
          : data.ai_explanation
          ? `<div><span class="result-label">Why:</span> ${data.ai_explanation}</div>`
          : ""
      }
    `;
    resultsEl.appendChild(aiCard);
  }

  if (!resultsEl.innerHTML) {
    resultsEl.textContent = "No detailed analysis returned.";
  }
}

/* ===========================
   ANALYZE CLICK
   =========================== */

analyzeBtn.addEventListener("click", async () => {
  const content = inputField.value.trim();
  const mode = getSelectedMode();

  if (!content) {
    statusEl.textContent = "Please paste some text or a YouTube URL.";
    return;
  }

  setLoading(true);
  resultsEl.innerHTML = "";

  try {
    const response = await fetch("http://localhost:8000/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ mode, content })
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    const data = await response.json();
    setLoading(false);
    renderResults(data);
    // save result so it persists when popup closes
    saveAnalysis(mode, content, data);
  } catch (err) {
    console.error(err);
    setLoading(false);
    statusEl.textContent = "Error contacting backend. Is it running?";
  }
});

/* ===========================
   SELECTION HANDLING (unchanged)
   =========================== */

// Populate textarea from highlighted selection on the active tab
async function populateFromSelection() {
  if (!useSelectionToggle || !useSelectionToggle.checked) return;
  statusEl.textContent = "Fetching selection from page...";

  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        statusEl.textContent = "No active tab.";
        return;
      }
      const tabId = tabs[0].id;

      try {
        chrome.scripting.executeScript(
          { target: { tabId }, func: () => window.getSelection().toString() },
          (injectionResults) => {
            if (chrome.runtime.lastError) {
              console.error(chrome.runtime.lastError);
              statusEl.textContent = "Cannot access page selection.";
              return;
            }

            if (!injectionResults || !injectionResults[0] || !injectionResults[0].result) {
              statusEl.textContent = "No text selected on the page.";
              return;
            }

            const selected = injectionResults[0].result;
            if (selected && selected.trim().length > 0) {
              inputField.value = selected.trim();
              statusEl.textContent = "Selection loaded into input.";
            } else {
              statusEl.textContent = "No text selected on the page.";
            }
          }
        );
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Error reading selection.";
      }
    });
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Error fetching tab.";
  }
}

// When the toggle changes, attempt to populate from selection
if (useSelectionToggle) {
  useSelectionToggle.addEventListener("change", () => {
    if (useSelectionToggle.checked) populateFromSelection();
    else statusEl.textContent = "";
  });

  // If the popup opened and the toggle was previously checked, try to fetch selection
  if (useSelectionToggle.checked) populateFromSelection();
}

// Restore previous analysis when popup opens
restoreAnalysisForCurrentTab();
