document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggleShield');
  const providerInput = document.getElementById('provider');
  const modelInput = document.getElementById('model');
  const baseUrlInput = document.getElementById('baseUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  const rescanBtn = document.getElementById('rescanBtn');
  const scanStatus = document.getElementById('scanStatus');

  const modelSelectionArea = document.getElementById('modelSelectionArea');
  const colOllama = document.getElementById('colOllama');
  const colLmStudio = document.getElementById('colLmStudio');
  const radioOllama = document.getElementById('radioOllama');
  const radioLmStudio = document.getElementById('radioLmStudio');
  const modelSelectOllama = document.getElementById('modelSelectOllama');
  const modelSelectLmStudio = document.getElementById('modelSelectLmStudio');
  const ollamaSelectContainer = document.getElementById('ollamaSelectContainer');
  const lmStudioSelectContainer = document.getElementById('lmStudioSelectContainer');
  const ollamaNoModels = document.getElementById('ollamaNoModels');
  const lmStudioNoModels = document.getElementById('lmStudioNoModels');

  const noModelsArea = document.getElementById('noModelsArea');
  const installOllamaSection = document.getElementById('installOllamaSection');
  const pullModelText = document.getElementById('pullModelText');
  const noModelsTitle = document.getElementById('noModelsTitle');

  const advancedToggle = document.getElementById('advancedToggle');
  const advancedArea = document.getElementById('advancedArea');

  // Load existing shield state
  const data = await chrome.storage.local.get(['shieldEnabled', 'provider', 'model', 'baseUrl', 'apiKey']);
  if (data.shieldEnabled !== undefined) toggle.checked = data.shieldEnabled;

  if (data.provider) providerInput.value = data.provider;
  if (data.model) modelInput.value = data.model;
  if (data.baseUrl) baseUrlInput.value = data.baseUrl;
  if (data.apiKey) apiKeyInput.value = data.apiKey;

  toggle.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ shieldEnabled: e.target.checked });
  });

  // Advanced Toggle
  let advancedOpen = false;
  advancedToggle.addEventListener('click', () => {
    advancedOpen = !advancedOpen;
    advancedArea.style.display = advancedOpen ? 'block' : 'none';
    advancedToggle.textContent = advancedOpen ? '▼ Custom / Advanced Configuration' : '► Custom / Advanced Configuration';
  });

  // Copy Buttons
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const targetId = e.target.getAttribute('data-target');
      const textToCopy = document.getElementById(targetId).innerText;
      navigator.clipboard.writeText(textToCopy).then(() => {
        const originalText = e.target.innerText;
        e.target.innerText = 'Copied!';
        setTimeout(() => { e.target.innerText = originalText; }, 2000);
      });
    });
  });

  let ollamaModels = [];
  let lmStudioModels = [];

  async function scanProviders() {
    scanStatus.style.display = 'block';
    modelSelectionArea.style.display = 'none';
    noModelsArea.style.display = 'none';
    modelSelectOllama.innerHTML = '';
    modelSelectLmStudio.innerHTML = '';
    ollamaModels = [];
    lmStudioModels = [];

    let isOllamaRunning = false;

    // Scan Ollama
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        isOllamaRunning = true;
        const json = await res.json();
        if (json && json.models) {
          json.models.forEach(m => {
            ollamaModels.push({
              id: `ollama-${m.name}`,
              provider: 'ollama',
              model: m.name,
              baseUrl: 'http://127.0.0.1:11434',
              apiKey: 'ollama'
            });
          });
        }
      }
    } catch (e) {
      console.log('Ollama scan failed:', e);
    }

    // Scan LM Studio
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch('http://127.0.0.1:1234/v1/models', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const json = await res.json();
        if (json && json.data) {
          json.data.forEach(m => {
            lmStudioModels.push({
              id: `lmstudio-${m.id}`,
              provider: 'openai-compatible',
              model: m.id,
              baseUrl: 'http://127.0.0.1:1234/v1',
              apiKey: 'lm-studio'
            });
          });
        }
      }
    } catch (e) {
      console.log('LM Studio scan failed:', e);
    }

    scanStatus.style.display = 'none';

    if (ollamaModels.length > 0 || lmStudioModels.length > 0) {
      modelSelectionArea.style.display = 'block';

      // Setup Ollama column
      if (ollamaModels.length > 0) {
        colOllama.classList.remove('disabled');
        ollamaSelectContainer.style.display = 'block';
        ollamaNoModels.style.display = 'none';
        radioOllama.disabled = false;

        ollamaModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.model;
          modelSelectOllama.appendChild(opt);
        });
      } else {
        colOllama.classList.add('disabled');
        ollamaSelectContainer.style.display = 'none';
        ollamaNoModels.style.display = 'block';
        radioOllama.disabled = true;
      }

      // Setup LM Studio column
      if (lmStudioModels.length > 0) {
        colLmStudio.classList.remove('disabled');
        lmStudioSelectContainer.style.display = 'block';
        lmStudioNoModels.style.display = 'none';
        radioLmStudio.disabled = false;

        lmStudioModels.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.model;
          modelSelectLmStudio.appendChild(opt);
        });
      } else {
        colLmStudio.classList.add('disabled');
        lmStudioSelectContainer.style.display = 'none';
        lmStudioNoModels.style.display = 'block';
        radioLmStudio.disabled = true;
      }

      // Set initial radio selection based on saved data, or fallback
      if (data.provider === 'ollama' && ollamaModels.length > 0) {
        radioOllama.checked = true;
        const matchingModel = ollamaModels.find(m => m.model === data.model);
        if (matchingModel) modelSelectOllama.value = matchingModel.id;
      } else if (data.provider === 'openai-compatible' && data.apiKey === 'lm-studio' && lmStudioModels.length > 0) {
        radioLmStudio.checked = true;
        const matchingModel = lmStudioModels.find(m => m.model === data.model);
        if (matchingModel) modelSelectLmStudio.value = matchingModel.id;
      } else if (ollamaModels.length > 0) {
        radioOllama.checked = true;
      } else {
        radioLmStudio.checked = true;
      }

      updateInputsFromSelection();
    } else {
      noModelsArea.style.display = 'block';
      if (isOllamaRunning) {
        noModelsTitle.innerText = "Ollama is running, but no models found.";
        installOllamaSection.style.display = 'none';
        pullModelText.style.display = 'block';
      } else {
        noModelsTitle.innerText = "No local models detected.";
        installOllamaSection.style.display = 'block';
        pullModelText.style.display = 'none';
      }
    }
  }

  function updateInputsFromSelection() {
    let selectedObj = null;
    if (radioOllama.checked) {
      selectedObj = ollamaModels.find(m => m.id === modelSelectOllama.value);
    } else if (radioLmStudio.checked) {
      selectedObj = lmStudioModels.find(m => m.id === modelSelectLmStudio.value);
    }

    if (selectedObj) {
      providerInput.value = selectedObj.provider;
      modelInput.value = selectedObj.model;
      baseUrlInput.value = selectedObj.baseUrl;
      apiKeyInput.value = selectedObj.apiKey;
    }
  }

  modelSelectOllama.addEventListener('change', () => { radioOllama.checked = true; updateInputsFromSelection(); });
  modelSelectLmStudio.addEventListener('change', () => { radioLmStudio.checked = true; updateInputsFromSelection(); });
  radioOllama.addEventListener('change', updateInputsFromSelection);
  radioLmStudio.addEventListener('change', updateInputsFromSelection);

  rescanBtn.addEventListener('click', scanProviders);

  saveBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      provider: providerInput.value.trim(),
      model: modelInput.value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim()
    });

    chrome.runtime.sendMessage({ action: 'updateConfig' });

    status.textContent = "Saved! Requests will go to " + baseUrlInput.value.trim();
    setTimeout(() => { status.textContent = ""; }, 3000);
  });

  // Initial Scan
  scanProviders();
});
