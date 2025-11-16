const analyzeBtn = document.getElementById("analyzeBtn");
const inputField = document.getElementById("inputField");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

const STORAGE_PREFIX = "analysis_"; // key prefix for chrome.storage

// Save input text as the user types
inputField.addEventListener("input", () => {
  const content = inputField.value;
  chrome.storage.local.set({ lastInput: content });
});

// Save selected mode when user clicks Text / Scan Text
const modeRadios = document.querySelectorAll('input[name="mode"]');
modeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    chrome.storage.local.set({ lastMode: radio.value });
  });
});


function getSelectedMode() {
  const radios = document.querySelectorAll('input[name="mode"]');
  for (const r of radios) {
    if (r.checked) return r.value;
  }
  return "text";
}

function setLoading(isLoading) {
  analyzeBtn.disabled = isLoading;
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
      timestamp: Date.now(),
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

      if (!saved) {
        // No previous analysis for this tab.
        // If Scan Text mode is selected and the textarea is empty, auto-scan selection.
        const mode = getSelectedMode();
        if (mode === "ScanText" && !inputField.value.trim()) {
          populateFromSelection();
        }
        return;
      }

      // Restore mode (text / ScanText)
      const radios = document.querySelectorAll('input[name="mode"]');
      radios.forEach((r) => {
        r.checked = r.value === saved.mode;
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

  // (AI-generated section removed in backend – this block will simply never render)

  if (!resultsEl.innerHTML) {
    resultsEl.textContent = "No detailed analysis returned.";
  }
}

/* ===========================
   ANALYZE CLICK
   =========================== */

analyzeBtn.addEventListener("click", async () => {
  const content = inputField.value.trim();
  const mode = getSelectedMode(); // used only for saving/restoring

  if (!content) {
    statusEl.textContent = "Please paste/scan some text to analyze.";
    return;
  }

  setLoading(true);
  resultsEl.innerHTML = "";

  try {
    const response = await fetch("http://localhost:8000/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      // backend now only expects { content }
      body: JSON.stringify({ content }),
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
   SELECTION HANDLING (Scan Text)
   =========================== */

// Grab highlighted selection from the active tab and put it in the textarea
function populateFromSelection() {
  statusEl.textContent = "Fetching selection from page...";

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
}

// Wire the "Scan Text" radio to trigger selection capture immediately
const textRadio = document.querySelector('input[name="mode"][value="text"]');
const scanRadio = document.querySelector('input[name="mode"][value="ScanText"]');

if (scanRadio) {
  scanRadio.addEventListener("change", () => {
    if (scanRadio.checked) {
      populateFromSelection();
    }
  });
}

if (textRadio) {
  textRadio.addEventListener("change", () => {
    if (textRadio.checked) {
      statusEl.textContent = "";
    }
  });
}

/* ===========================
    RESTORE SETTINGS
   =========================== */

   function restoreGlobalSettings() {
  chrome.storage.local.get(["lastInput", "lastMode"], (items) => {
    // Restore text
    if (typeof items.lastInput === "string") {
      inputField.value = items.lastInput;
    }

    // Restore mode
    if (items.lastMode) {
      const radios = document.querySelectorAll('input[name="mode"]');
      radios.forEach((r) => {
        r.checked = (r.value === items.lastMode);
      });
    }
  });
}

// Call this when popup opens
restoreGlobalSettings();
restoreAnalysisForCurrentTab();
