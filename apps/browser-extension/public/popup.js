const PRESETS = {
  ollama: {
    provider: "ollama",
    model: "qwen3.5:2b",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: "ollama"
  },
  lmstudio: {
    provider: "openai-compatible",
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "lm-studio"
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggleShield');
  const provider = document.getElementById('provider');
  const model = document.getElementById('model');
  const baseUrl = document.getElementById('baseUrl');
  const apiKey = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  function applyPreset(preset) {
    provider.value = preset.provider;
    model.value = preset.model;
    baseUrl.value = preset.baseUrl;
    apiKey.value = preset.apiKey;
  }

  document.getElementById('presetOllama').addEventListener('click', () => applyPreset(PRESETS.ollama));
  document.getElementById('presetLmStudio').addEventListener('click', () => applyPreset(PRESETS.lmstudio));

  const data = await chrome.storage.local.get(['shieldEnabled', 'provider', 'model', 'baseUrl', 'apiKey']);

  if (data.shieldEnabled !== undefined) toggle.checked = data.shieldEnabled;
  if (data.provider) provider.value = data.provider;
  if (data.model) model.value = data.model;
  if (data.baseUrl) baseUrl.value = data.baseUrl;
  if (data.apiKey) apiKey.value = data.apiKey;

  toggle.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ shieldEnabled: e.target.checked });
  });

  saveBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      provider: provider.value.trim(),
      model: model.value.trim(),
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim()
    });

    chrome.runtime.sendMessage({ action: 'updateConfig' });

    status.textContent = "Saved! Requests will go to " + baseUrl.value.trim();
    setTimeout(() => { status.textContent = ""; }, 3000);
  });
});