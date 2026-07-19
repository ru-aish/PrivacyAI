import {
  buildImagePayload,
  copyPromptToClipboard,
  formatBytes,
  normalizeImagePreviewResponse,
  validateImageFile
} from "./app-core.js";

const byId = id => document.getElementById(id);
const elements = {
  statusText: byId("statusText"),
  statusDot: byId("statusDot"),
  providerBadge: byId("providerBadge"),
  textModeButton: byId("textModeButton"),
  imageModeButton: byId("imageModeButton"),
  textModePanel: byId("textModePanel"),
  imageModePanel: byId("imageModePanel"),
  systemPrompt: byId("systemPrompt"),
  userMessage: byId("userMessage"),
  imagePrompt: byId("imagePrompt"),
  imageFile: byId("imageFile"),
  dropZone: byId("dropZone"),
  selectedFile: byId("selectedFile"),
  selectedImageThumb: byId("selectedImageThumb"),
  selectedFileName: byId("selectedFileName"),
  selectedFileMeta: byId("selectedFileMeta"),
  clearImageButton: byId("clearImageButton"),
  sendButton: byId("sendButton"),
  sanitizeOnlyButton: byId("sanitizeOnlyButton"),
  testConnectionButton: byId("testConnectionButton"),
  sanitizeImageButton: byId("sanitizeImageButton"),
  copyPromptButton: byId("copyPromptButton"),
  textResults: byId("textResults"),
  imageResults: byId("imageResults"),
  errorSection: byId("errorSection"),
  errorMessage: byId("errorMessage")
};

let selectedImageDataUrl = "";
let activeMode = "text";

window.addEventListener("DOMContentLoaded", checkStatus);
elements.textModeButton.addEventListener("click", () => setMode("text"));
elements.imageModeButton.addEventListener("click", () => setMode("image"));
elements.sendButton.addEventListener("click", processMessage);
elements.sanitizeOnlyButton.addEventListener("click", sanitizeOnly);
elements.testConnectionButton.addEventListener("click", testConnection);
elements.sanitizeImageButton.addEventListener("click", sanitizeImage);
elements.imageFile.addEventListener("change", event => selectImage(event.target.files?.[0]));
elements.clearImageButton.addEventListener("click", clearImage);
elements.copyPromptButton.addEventListener("click", copySafePrompt);

elements.dropZone.addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.imageFile.click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
}
elements.dropZone.addEventListener("drop", event => selectImage(event.dataTransfer?.files?.[0]));

for (const textarea of [elements.systemPrompt, elements.userMessage, elements.imagePrompt]) {
  textarea.addEventListener("input", autoResize);
}
elements.userMessage.addEventListener("keydown", event => {
  if (event.key === "Enter" && event.ctrlKey) processMessage();
});

async function checkStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    if (!response.ok || data.status !== "running") throw new Error(data.error || "Service unavailable");
    elements.statusDot.className = "status-dot is-online";
    elements.statusText.textContent = "Boundary ready";
    elements.providerBadge.textContent = `${data.provider_label} · ${data.model}`;
  } catch (error) {
    elements.statusDot.className = "status-dot is-error";
    elements.statusText.textContent = "Boundary unavailable";
    elements.providerBadge.textContent = error.message;
  }
}

function setMode(mode) {
  activeMode = mode;
  const imageMode = mode === "image";
  elements.textModePanel.hidden = imageMode;
  elements.imageModePanel.hidden = !imageMode;
  elements.textModeButton.classList.toggle("is-active", !imageMode);
  elements.imageModeButton.classList.toggle("is-active", imageMode);
  elements.textModeButton.setAttribute("aria-selected", String(!imageMode));
  elements.imageModeButton.setAttribute("aria-selected", String(imageMode));
  hideResults();
  hideError();
}

async function selectImage(file) {
  const error = validateImageFile(file);
  if (error) return showError(error);
  try {
    selectedImageDataUrl = await readFileAsDataUrl(file);
    elements.selectedImageThumb.src = selectedImageDataUrl;
    elements.selectedFileName.textContent = file.name;
    elements.selectedFileMeta.textContent = `${formatBytes(file.size)} · ${file.type.replace("image/", "").toUpperCase()}`;
    elements.selectedFile.hidden = false;
    elements.dropZone.hidden = true;
    hideError();
  } catch (error) {
    showError(`Could not read the selected image: ${error.message}`);
  }
}

function clearImage() {
  selectedImageDataUrl = "";
  elements.imageFile.value = "";
  elements.selectedImageThumb.removeAttribute("src");
  elements.selectedFile.hidden = true;
  elements.dropZone.hidden = false;
  elements.imageResults.hidden = true;
}

async function sanitizeImage() {
  try {
    const payload = buildImagePayload(elements.imagePrompt.value, selectedImageDataUrl);
    setLoading(true);
    hideResults();
    hideError();
    const response = await fetch("/api/sanitize-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Image sanitization failed.");
    showImageResults(normalizeImagePreviewResponse(data, selectedImageDataUrl));
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function showImageResults(result) {
  elements.textResults.hidden = true;
  elements.imageResults.hidden = false;
  byId("originalImagePreview").src = result.originalImageUrl;
  byId("sanitizedImagePreview").src = result.sanitizedImageUrl;
  byId("originalImagePrompt").textContent = result.originalPrompt;
  byId("sanitizedImagePrompt").textContent = result.sanitizedPrompt;
  byId("downloadImageLink").href = result.sanitizedImageUrl;
  byId("ocrLineCount").textContent = String(result.detectedLineCount);
  byId("regionCount").textContent = String(result.protectedRegionCount);
  byId("maskStrategy").textContent = result.maskStrategy;
  byId("verificationAttempts").textContent = String(result.verificationAttempts);
  renderTags(byId("imagePrivacyItems"), result.privacyItems, "No private values detected");
  const statuses = byId("imageResultStatuses");
  statuses.replaceChildren(
    statusPill(result.imageChanged ? "Image changed" : "Image unchanged", result.imageChanged),
    statusPill(result.promptChanged ? "Prompt changed" : "Prompt unchanged", result.promptChanged)
  );
  elements.imageResults.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function processMessage() {
  const message = elements.userMessage.value.trim();
  if (!message) return showError("Enter a message before sending.");
  await runTextRequest("/api/process", {
    message,
    system_prompt: elements.systemPrompt.value.trim() || undefined
  }, data => showTextResults({
    original: message,
    sanitized: data.sanitized_message,
    privacyItems: data.privacy_items_detected,
    aiResponse: data.ai_response,
    finalResponse: data.final_response
  }));
}

async function sanitizeOnly() {
  const message = elements.userMessage.value.trim();
  if (!message) return showError("Enter a message before sanitizing.");
  await runTextRequest("/api/sanitize", { message }, data => showTextResults({
    original: data.original_message,
    sanitized: data.sanitized_message,
    privacyItems: data.privacy_items_detected
  }));
}

async function testConnection() {
  await runTextRequest("/api/test-connection", {}, data => showTextResults({
    original: "Connection probe",
    sanitized: `Ollama connection succeeded through ${data.service}.`,
    aiResponse: data.response,
    privacyItems: []
  }));
}

async function runTextRequest(endpoint, payload, onSuccess) {
  try {
    setLoading(true);
    hideResults();
    hideError();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || data.status !== "success") throw new Error(data.error || "Request failed.");
    onSuccess(data);
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

function showTextResults(data) {
  elements.imageResults.hidden = true;
  elements.textResults.hidden = false;
  byId("originalMessage").textContent = data.original || "";
  byId("sanitizedMessage").textContent = data.sanitized || "";
  renderTags(byId("privacyItems"), data.privacyItems || [], "No private values detected");
  const aiBox = byId("aiResponseBox");
  aiBox.hidden = !data.aiResponse;
  byId("aiResponse").textContent = data.aiResponse || "";
  const finalBox = byId("finalResponseBox");
  finalBox.hidden = !data.finalResponse;
  byId("finalResponse").textContent = data.finalResponse || "";
  elements.textResults.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTags(container, values, emptyText) {
  container.replaceChildren();
  if (!values.length) {
    const empty = document.createElement("span");
    empty.className = "empty-tag";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }
  for (const value of values) {
    const tag = document.createElement("code");
    tag.className = "privacy-tag";
    tag.textContent = value;
    container.append(tag);
  }
}

function statusPill(text, changed) {
  const element = document.createElement("span");
  element.className = changed ? "status-pill is-changed" : "status-pill";
  element.textContent = text;
  return element;
}

async function copySafePrompt() {
  const prompt = byId("sanitizedImagePrompt").textContent;
  if (!prompt) return;
  await copyPromptToClipboard({
    text: prompt,
    clipboard: navigator.clipboard,
    button: elements.copyPromptButton
  });
}

function showError(message) {
  hideResults();
  elements.errorSection.hidden = false;
  elements.errorMessage.textContent = message;
}

function hideResults() {
  elements.textResults.hidden = true;
  elements.imageResults.hidden = true;
}

function hideError() {
  elements.errorSection.hidden = true;
}

function setLoading(loading) {
  for (const button of [
    elements.sendButton,
    elements.sanitizeOnlyButton,
    elements.testConnectionButton,
    elements.sanitizeImageButton
  ]) {
    button.disabled = loading;
  }
  elements.sanitizeImageButton.textContent = loading && activeMode === "image"
    ? "Running OCR and privacy checks…"
    : "Show provider-bound version";
}

function autoResize() {
  this.style.height = "auto";
  this.style.height = `${this.scrollHeight}px`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("File reading failed."));
    reader.readAsDataURL(file);
  });
}
