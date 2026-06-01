// Privacy Guardian Gateway JavaScript

// DOM Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const statusDot = statusIndicator.querySelector('.status-dot');
const aiServiceSelect = document.getElementById('aiService');
const systemPromptInput = document.getElementById('systemPrompt');
const userMessageInput = document.getElementById('userMessage');
const sendButton = document.getElementById('sendButton');
const sanitizeOnlyButton = document.getElementById('sanitizeOnlyButton');
const testConnectionButton = document.getElementById('testConnectionButton');
const resultsSection = document.getElementById('resultsSection');
const errorSection = document.getElementById('errorSection');

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    checkStatus();
    
    // Set up event listeners
    aiServiceSelect.addEventListener('change', testConnection);
});

// Check service status
async function checkStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        
        if (data.status === 'running') {
            updateStatus('online', 'Services Online');
            
            // Set default service
            aiServiceSelect.value = data.default_ai_service;
            
            // Update service status indicators (could be expanded)
            console.log('Service Status:', data.services);
        } else {
            updateStatus('error', 'Service Error');
        }
    } catch (error) {
        updateStatus('error', 'Connection Failed');
        console.error('Status check failed:', error);
    }
}

// Update status indicator
function updateStatus(status, text) {
    statusText.textContent = text;
    statusDot.className = `status-dot ${status}`;
}

// Process message with full pipeline
async function processMessage() {
    const userMessage = userMessageInput.value.trim();
    const systemPrompt = systemPromptInput.value.trim();
    const aiService = aiServiceSelect.value;

    if (!userMessage) {
        showError('Please enter a message');
        return;
    }

    setLoading(true);
    hideResults();
    hideError();

    try {
        const payload = {
            message: userMessage,
            ai_service: aiService
        };

        if (systemPrompt) {
            payload.system_prompt = systemPrompt;
        }

        const response = await fetch('/api/process', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (data.status === 'success') {
            showResults({
                original: userMessage,
                sanitized: data.sanitized_message,
                aiResponse: data.ai_response,
                finalResponse: data.final_response,
                privacyItems: data.privacy_items_detected,
                aiService: data.ai_service_used
            });
        } else {
            showError(data.error || 'Unknown error occurred');
        }

    } catch (error) {
        showError(`Network error: ${error.message}`);
    } finally {
        setLoading(false);
    }
}

// Sanitize only (preview mode)
async function sanitizeOnly() {
    const userMessage = userMessageInput.value.trim();

    if (!userMessage) {
        showError('Please enter a message');
        return;
    }

    setLoading(true);
    hideResults();
    hideError();

    try {
        const response = await fetch('/api/sanitize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: userMessage
            })
        });

        const data = await response.json();

        if (data.status === 'success') {
            showResults({
                original: data.original_message,
                sanitized: data.sanitized_message,
                privacyItems: data.privacy_items_detected,
                previewMode: true
            });
        } else {
            showError(data.error || 'Unknown error occurred');
        }

    } catch (error) {
        showError(`Network error: ${error.message}`);
    } finally {
        setLoading(false);
    }
}

// Test AI connection
async function testConnection() {
    const aiService = aiServiceSelect.value;
    
    setLoading(true);
    hideResults();
    hideError();

    try {
        const response = await fetch('/api/test-connection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                service: aiService
            })
        });

        const data = await response.json();

        if (data.status === 'success') {
            showResults({
                testMode: true,
                service: data.service,
                response: data.response
            });
            updateStatus('online', `${aiService.toUpperCase()} Connected`);
        } else {
            showError(`${aiService.toUpperCase()} connection failed: ${data.error}`);
            updateStatus('error', `${aiService.toUpperCase()} Failed`);
        }

    } catch (error) {
        showError(`Network error: ${error.message}`);
        updateStatus('error', 'Connection Failed');
    } finally {
        setLoading(false);
    }
}

// Show results
function showResults(data) {
    hideError();
    
    // Show results section
    resultsSection.style.display = 'block';
    
    // Original message
    document.getElementById('originalMessage').textContent = data.original;
    
    if (data.testMode) {
        // Test mode - show connection test results
        document.getElementById('sanitizedBox').style.display = 'block';
        document.getElementById('sanitizedMessage').textContent = `Connection test to ${data.service.toUpperCase()} successful!`;
        document.getElementById('privacyItems').innerHTML = '';
        
        document.getElementById('aiResponseBox').style.display = 'block';
        document.getElementById('aiResponse').textContent = data.response;
        
        document.getElementById('finalResponseBox').style.display = 'none';
        return;
    }
    
    // Sanitized message
    if (data.sanitized) {
        document.getElementById('sanitizedBox').style.display = 'block';
        document.getElementById('sanitizedMessage').textContent = data.sanitized;
        
        // Privacy items
        const privacyItemsDiv = document.getElementById('privacyItems');
        if (data.privacyItems && data.privacyItems.length > 0) {
            privacyItemsDiv.innerHTML = '<strong>Protected items:</strong> ' +
                data.privacyItems.map(item => `<span class="privacy-tag">${item}</span>`).join(' ');
        } else {
            privacyItemsDiv.innerHTML = '<strong>No sensitive information detected</strong>';
        }
    }
    
    // AI Response (only in full processing mode)
    if (data.aiResponse && !data.previewMode) {
        document.getElementById('aiResponseBox').style.display = 'block';
        document.getElementById('aiResponse').textContent = data.aiResponse;
    } else {
        document.getElementById('aiResponseBox').style.display = 'none';
    }
    
    // Final response (only in full processing mode)
    if (data.finalResponse && !data.previewMode) {
        document.getElementById('finalResponseBox').style.display = 'block';
        document.getElementById('finalResponse').textContent = data.finalResponse;
    } else {
        document.getElementById('finalResponseBox').style.display = 'none';
    }
}

// Show error
function showError(message) {
    hideResults();
    errorSection.style.display = 'block';
    document.getElementById('errorMessage').textContent = message;
}

// Hide results
function hideResults() {
    resultsSection.style.display = 'none';
}

// Hide error
function hideError() {
    errorSection.style.display = 'none';
}

// Set loading state
function setLoading(isLoading) {
    const buttons = [sendButton, sanitizeOnlyButton, testConnectionButton];
    
    buttons.forEach(button => {
        button.disabled = isLoading;
        
        const buttonText = button.querySelector('.button-text') || button;
        const spinner = button.querySelector('.loading-spinner');
        
        if (isLoading) {
            if (spinner) {
                spinner.style.display = 'inline';
                buttonText.style.display = 'none';
            } else {
                button.textContent = 'Processing...';
            }
        } else {
            if (spinner) {
                spinner.style.display = 'none';
                buttonText.style.display = 'inline';
            } else {
                // Restore original button text
                if (button === sendButton) button.textContent = 'Send Message';
                else if (button === sanitizeOnlyButton) button.textContent = 'Preview Sanitization';
                else if (button === testConnectionButton) button.textContent = 'Test AI Connection';
            }
        }
    });
}

// Handle Enter key in textareas
userMessageInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.ctrlKey) {
        processMessage();
    }
});

// Auto-resize textareas
function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

userMessageInput.addEventListener('input', function() {
    autoResize(this);
});

systemPromptInput.addEventListener('input', function() {
    autoResize(this);
});