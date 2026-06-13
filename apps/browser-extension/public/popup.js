document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggleShield');
  const provider = document.getElementById('provider');
  const model = document.getElementById('model');
  const baseUrl = document.getElementById('baseUrl');
  const apiKey = document.getElementById('apiKey');
  const saveBtn = document.getElementById('saveBtn');
  const status = document.getElementById('status');

  // Load existing config
  const data = await chrome.storage.local.get(['shieldEnabled', 'provider', 'model', 'baseUrl', 'apiKey']);

  if (data.shieldEnabled !== undefined) toggle.checked = data.shieldEnabled;
  if (data.provider) provider.value = data.provider;
  if (data.model) model.value = data.model;
  if (data.baseUrl) baseUrl.value = data.baseUrl;
  if (data.apiKey) apiKey.value = data.apiKey;

  // Toggle listener
  toggle.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ shieldEnabled: e.target.checked });
  });

  // Save Config listener
  saveBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      provider: provider.value,
      model: model.value,
      baseUrl: baseUrl.value,
      apiKey: apiKey.value
    });

    // Notify background script to re-initialize the client
    chrome.runtime.sendMessage({ action: 'updateConfig' });

    status.textContent = "Saved!";
    setTimeout(() => { status.textContent = ""; }, 2000);
  });
});
