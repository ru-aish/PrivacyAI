const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const statusDot = statusIndicator.querySelector(".status-dot");
const providerBadge = document.getElementById("providerBadge");
const systemPromptInput = document.getElementById("systemPrompt");
const userMessageInput = document.getElementById("userMessage");
const sendButton = document.getElementById("sendButton");
const sanitizeOnlyButton = document.getElementById("sanitizeOnlyButton");
const testConnectionButton = document.getElementById("testConnectionButton");
const resultsSection = document.getElementById("resultsSection");
const errorSection = document.getElementById("errorSection");

document.addEventListener("DOMContentLoaded", () => {
  checkStatus();
});

async function checkStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();

    if (data.status === "running") {
      updateStatus("online", "SDK Ready");
      providerBadge.textContent = `Provider: ${data.provider_label} (${data.model})`;
    } else {
      updateStatus("error", "Service Error");
    }
  } catch (error) {
    updateStatus("error", "Connection Failed");
    console.error("Status check failed:", error);
  }
}

function updateStatus(status, text) {
  statusText.textContent = text;
  statusDot.className = `status-dot ${status}`;
}

async function processMessage() {
  const userMessage = userMessageInput.value.trim();
  const systemPrompt = systemPromptInput.value.trim();

  if (!userMessage) {
    showError("Please enter a message");
    return;
  }

  setLoading(true);
  hideResults();
  hideError();

  try {
    const payload = { message: userMessage };
    if (systemPrompt) payload.system_prompt = systemPrompt;

    const response = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (data.status === "success") {
      showResults({
        original: userMessage,
        sanitized: data.sanitized_message,
        aiResponse: data.ai_response,
        finalResponse: data.final_response,
        privacyItems: data.privacy_items_detected
      });
    } else {
      showError(data.error || "Unknown error occurred");
    }
  } catch (error) {
    showError(`Network error: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

async function sanitizeOnly() {
  const userMessage = userMessageInput.value.trim();
  if (!userMessage) {
    showError("Please enter a message");
    return;
  }

  setLoading(true);
  hideResults();
  hideError();

  try {
    const response = await fetch("/api/sanitize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userMessage })
    });

    const data = await response.json();
    if (data.status === "success") {
      showResults({
        original: data.original_message,
        sanitized: data.sanitized_message,
        privacyItems: data.privacy_items_detected,
        previewMode: true
      });
    } else {
      showError(data.error || "Unknown error occurred");
    }
  } catch (error) {
    showError(`Network error: ${error.message}`);
  } finally {
    setLoading(false);
  }
}

async function testConnection() {
  setLoading(true);
  hideResults();
  hideError();

  try {
    const response = await fetch("/api/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });

    const data = await response.json();
    if (data.status === "success") {
      showResults({
        testMode: true,
        service: data.service,
        response: data.response
      });
      updateStatus("online", `${data.service} Connected`);
    } else {
      showError(`${data.service || "Provider"} connection failed: ${data.error}`);
      updateStatus("error", "Connection Failed");
    }
  } catch (error) {
    showError(`Network error: ${error.message}`);
    updateStatus("error", "Connection Failed");
  } finally {
    setLoading(false);
  }
}

function showResults(data) {
  hideError();
  resultsSection.style.display = "block";
  document.getElementById("originalMessage").textContent = data.original || "";

  if (data.testMode) {
    document.getElementById("sanitizedBox").style.display = "block";
    document.getElementById("sanitizedMessage").textContent =
      `Connection test to ${data.service} successful.`;
    document.getElementById("privacyItems").innerHTML = "";
    document.getElementById("aiResponseBox").style.display = "block";
    document.getElementById("aiResponse").textContent = data.response;
    document.getElementById("finalResponseBox").style.display = "none";
    return;
  }

  if (data.sanitized) {
    document.getElementById("sanitizedBox").style.display = "block";
    document.getElementById("sanitizedMessage").textContent = data.sanitized;

    const privacyItemsDiv = document.getElementById("privacyItems");
    if (data.privacyItems?.length) {
      privacyItemsDiv.innerHTML =
        "<strong>Protected items:</strong> " +
        data.privacyItems.map((item) => `<span class="privacy-tag">${item}</span>`).join(" ");
    } else {
      privacyItemsDiv.innerHTML = "<strong>No sensitive information detected</strong>";
    }
  }

  if (data.aiResponse && !data.previewMode) {
    document.getElementById("aiResponseBox").style.display = "block";
    document.getElementById("aiResponse").textContent = data.aiResponse;
  } else {
    document.getElementById("aiResponseBox").style.display = "none";
  }

  if (data.finalResponse && !data.previewMode) {
    document.getElementById("finalResponseBox").style.display = "block";
    document.getElementById("finalResponse").textContent = data.finalResponse;
  } else {
    document.getElementById("finalResponseBox").style.display = "none";
  }
}

function showError(message) {
  hideResults();
  errorSection.style.display = "block";
  document.getElementById("errorMessage").textContent = message;
}

function hideResults() {
  resultsSection.style.display = "none";
}

function hideError() {
  errorSection.style.display = "none";
}

function setLoading(isLoading) {
  for (const button of [sendButton, sanitizeOnlyButton, testConnectionButton]) {
    button.disabled = isLoading;
    const buttonText = button.querySelector(".button-text") || button;
    const spinner = button.querySelector(".loading-spinner");

    if (isLoading) {
      if (spinner) {
        spinner.style.display = "inline";
        buttonText.style.display = "none";
      } else {
        button.textContent = "Processing...";
      }
    } else if (spinner) {
      spinner.style.display = "none";
      buttonText.style.display = "inline";
    }
  }
}

userMessageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.ctrlKey) processMessage();
});

for (const textarea of [userMessageInput, systemPromptInput]) {
  textarea.addEventListener("input", function onInput() {
    this.style.height = "auto";
    this.style.height = `${this.scrollHeight}px`;
  });
}