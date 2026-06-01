# Privacy Guardian Gateway - API Documentation

## Base URL

- **Development**: `http://localhost:5000`
- **Production**: `https://yourdomain.com`

## Authentication

No authentication required for public endpoints. Health monitoring endpoints require token authentication.

## Content Type

All POST requests must use `Content-Type: application/json`

## Rate Limiting

- **Limit**: 60 requests per minute per IP address
- **Response**: `429 Too Many Requests` when exceeded
- **Headers**: Rate limit info included in response headers

## API Endpoints

### 1. Process Message with AI

Process a user message through privacy sanitization and AI generation.

**Endpoint**: `POST /api/process`

**Request Body**:
```json
{
  "message": "string (required) - User message to process",
  "ai_service": "string (optional) - 'gemini' or 'lm_studio'",
  "system_prompt": "string (optional) - System prompt for AI"
}
```

**Response** (Success - 200):
```json
{
  "status": "success",
  "sanitized_message": "string - Message with PII replaced",
  "ai_response": "string - AI response to sanitized message",
  "final_response": "string - AI response with PII restored",
  "privacy_items_detected": ["array of strings - PII types found"],
  "ai_service_used": "string - AI service that was used"
}
```

**Response** (Error - 400/500):
```json
{
  "status": "error",
  "error": "string - Error description"
}
```

**Example**:
```bash
curl -X POST http://localhost:5000/api/process \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hi, I am John Doe and my email is john@example.com",
    "ai_service": "gemini",
    "system_prompt": "You are a helpful assistant"
  }'
```

### 2. Sanitize Only

Sanitize user input without AI processing.

**Endpoint**: `POST /api/sanitize`

**Request Body**:
```json
{
  "message": "string (required) - Message to sanitize"
}
```

**Response** (Success - 200):
```json
{
  "status": "success",
  "original_message": "string - Original input message",
  "sanitized_message": "string - Message with PII replaced",
  "privacy_items_detected": ["array of strings - PII types found"],
  "replacements": {
    "PLACEHOLDER_TYPE": "original_value"
  }
}
```

**Example**:
```bash
curl -X POST http://localhost:5000/api/sanitize \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Call me at 555-123-4567 or email john@example.com"
  }'
```

### 3. Test AI Connection

Test connectivity to AI services.

**Endpoint**: `POST /api/test-connection`

**Request Body**:
```json
{
  "service": "string (optional) - 'gemini' or 'lm_studio'"
}
```

**Response** (Success - 200):
```json
{
  "status": "success",
  "service": "string - Service tested",
  "message": "string - Success message"
}
```

**Response** (Error - 500):
```json
{
  "status": "error",
  "service": "string - Service tested",
  "error": "string - Error description"
}
```

**Example**:
```bash
curl -X POST http://localhost:5000/api/test-connection \
  -H "Content-Type: application/json" \
  -d '{"service": "gemini"}'
```

### 4. Service Status

Get overall service status and configuration.

**Endpoint**: `GET /api/status`

**Response** (Success - 200):
```json
{
  "status": "running",
  "default_ai_service": "string - Default AI service",
  "services": {
    "gemini": {
      "status": "success|error",
      "message": "string - Status message"
    },
    "lm_studio": {
      "status": "success|error", 
      "message": "string - Status message"
    }
  },
  "privacy_processor": "operational"
}
```

**Example**:
```bash
curl http://localhost:5000/api/status
```

### 5. Health Check

Health monitoring endpoint for external monitoring systems.

**Endpoint**: `GET /health`

**Query Parameters**:
- `token` (optional) - Health check token for authentication

**Response** (Success - 200):
```json
{
  "status": "healthy",
  "timestamp": "string - Current timestamp",
  "privacy_engine": "operational|error",
  "ai_services": "available|unavailable"
}
```

**Response** (Unhealthy - 503):
```json
{
  "status": "unhealthy",
  "error": "string - Error description"
}
```

**Example**:
```bash
curl "http://localhost:5000/health?token=your-health-token"
```

### 6. Metrics

Basic metrics for monitoring and observability.

**Endpoint**: `GET /metrics`

**Query Parameters**:
- `token` (required) - Health check token for authentication

**Response** (Success - 200):
```json
{
  "active_connections": "number - Current active connections",
  "rate_limit_storage_size": "number - Rate limit entries",
  "privacy_processor_status": "operational"
}
```

**Response** (Disabled - 404):
```json
{
  "error": "Metrics disabled"
}
```

**Example**:
```bash
curl "http://localhost:5000/metrics?token=your-health-token"
```

## Error Codes

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (missing required fields, invalid JSON)
- `401` - Unauthorized (invalid or missing token)
- `404` - Not Found (endpoint doesn't exist or disabled)
- `413` - Request Too Large (exceeds 16MB limit)
- `429` - Too Many Requests (rate limit exceeded)
- `500` - Internal Server Error (server-side error)
- `503` - Service Unavailable (health check failed)

### Common Error Responses

#### Missing Required Field
```json
{
  "status": "error",
  "error": "Missing 'message' field in request"
}
```

#### Rate Limit Exceeded
```json
{
  "error": "Rate limit exceeded"
}
```

#### Request Too Large
```json
{
  "error": "Request too large"
}
```

#### AI Service Unavailable
```json
{
  "status": "error",
  "error": "AI service unavailable: Connection failed"
}
```

#### Invalid Content Type
```json
{
  "error": "Content-Type must be application/json"
}
```

## Privacy Data Types

The system detects and protects the following PII types:

### Personal Information
- `PERSON_NAME` - Full names (John Doe, Jane Smith)
- `EMAIL_ADDRESS` - Email addresses (user@example.com)
- `PHONE_NUMBER` - Phone numbers (555-123-4567, +1-555-123-4567)

### Financial Information
- `CREDIT_CARD` - Credit card numbers (4532-1234-5678-9012)
- `SSN` - Social Security Numbers (123-45-6789)
- `BANK_ACCOUNT` - Bank account numbers

### Location Information
- `ADDRESS` - Street addresses (123 Main St, Apt 4B)
- `IP_ADDRESS` - IP addresses (192.168.1.1, 2001:db8::1)
- `COORDINATES` - GPS coordinates (40.7128, -74.0060)

### Identity Documents
- `DRIVERS_LICENSE` - Driver's license numbers
- `PASSPORT` - Passport numbers
- `NATIONAL_ID` - National identification numbers

### Digital Identifiers
- `USERNAME` - Usernames (@johndoe, user123)
- `URL` - URLs with personal information
- `API_KEY` - API keys and tokens

## Request/Response Examples

### Complete Privacy Processing Example

**Request**:
```bash
curl -X POST http://localhost:5000/api/process \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, I am Dr. Sarah Johnson from New York. My email is sarah.johnson@hospital.com and my office number is 212-555-0123. I need help with patient data analysis for cases at 123 Medical Plaza, Suite 456.",
    "ai_service": "gemini",
    "system_prompt": "You are a helpful medical data analysis assistant."
  }'
```

**Response**:
```json
{
  "status": "success",
  "sanitized_message": "Hello, I am PLACEHOLDER_PERSON_NAME from PLACEHOLDER_LOCATION. My email is PLACEHOLDER_EMAIL_ADDRESS and my office number is PLACEHOLDER_PHONE_NUMBER. I need help with patient data analysis for cases at PLACEHOLDER_ADDRESS.",
  "ai_response": "Hello PLACEHOLDER_PERSON_NAME! I'd be happy to help you with medical data analysis. As a medical professional at PLACEHOLDER_ADDRESS, I can assist you with...",
  "final_response": "Hello Dr. Sarah Johnson! I'd be happy to help you with medical data analysis. As a medical professional at 123 Medical Plaza, Suite 456, I can assist you with...",
  "privacy_items_detected": [
    "PERSON_NAME",
    "LOCATION", 
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "ADDRESS"
  ],
  "ai_service_used": "gemini"
}
```

### Sanitization Only Example

**Request**:
```bash
curl -X POST http://localhost:5000/api/sanitize \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Please contact John Smith at john.smith@company.com or call 555-987-6543. His address is 789 Oak Street, Apartment 12B, and his SSN is 123-45-6789."
  }'
```

**Response**:
```json
{
  "status": "success",
  "original_message": "Please contact John Smith at john.smith@company.com or call 555-987-6543. His address is 789 Oak Street, Apartment 12B, and his SSN is 123-45-6789.",
  "sanitized_message": "Please contact PLACEHOLDER_PERSON_NAME at PLACEHOLDER_EMAIL_ADDRESS or call PLACEHOLDER_PHONE_NUMBER. His address is PLACEHOLDER_ADDRESS, and his SSN is PLACEHOLDER_SSN.",
  "privacy_items_detected": [
    "PERSON_NAME",
    "EMAIL_ADDRESS", 
    "PHONE_NUMBER",
    "ADDRESS",
    "SSN"
  ],
  "replacements": {
    "PERSON_NAME": "John Smith",
    "EMAIL_ADDRESS": "john.smith@company.com",
    "PHONE_NUMBER": "555-987-6543", 
    "ADDRESS": "789 Oak Street, Apartment 12B",
    "SSN": "123-45-6789"
  }
}
```

## SDK and Integration Examples

### Python Integration

```python
import requests
import json

class PrivacyGuardianClient:
    def __init__(self, base_url="http://localhost:5000"):
        self.base_url = base_url
    
    def process_message(self, message, ai_service=None, system_prompt=None):
        """Process message with privacy protection and AI response"""
        payload = {"message": message}
        if ai_service:
            payload["ai_service"] = ai_service
        if system_prompt:
            payload["system_prompt"] = system_prompt
            
        response = requests.post(
            f"{self.base_url}/api/process",
            json=payload,
            headers={"Content-Type": "application/json"}
        )
        return response.json()
    
    def sanitize_only(self, message):
        """Sanitize message without AI processing"""
        response = requests.post(
            f"{self.base_url}/api/sanitize",
            json={"message": message},
            headers={"Content-Type": "application/json"}
        )
        return response.json()
    
    def test_connection(self, service="gemini"):
        """Test AI service connection"""
        response = requests.post(
            f"{self.base_url}/api/test-connection",
            json={"service": service},
            headers={"Content-Type": "application/json"}
        )
        return response.json()

# Usage example
client = PrivacyGuardianClient()

# Process with AI
result = client.process_message(
    message="Hi, I'm John Doe and my email is john@example.com",
    ai_service="gemini"
)
print(result["final_response"])

# Sanitize only
sanitized = client.sanitize_only("My phone is 555-123-4567")
print(sanitized["sanitized_message"])
```

### JavaScript/Node.js Integration

```javascript
class PrivacyGuardianClient {
  constructor(baseUrl = 'http://localhost:5000') {
    this.baseUrl = baseUrl;
  }

  async processMessage(message, aiService = null, systemPrompt = null) {
    const payload = { message };
    if (aiService) payload.ai_service = aiService;
    if (systemPrompt) payload.system_prompt = systemPrompt;

    const response = await fetch(`${this.baseUrl}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return await response.json();
  }

  async sanitizeOnly(message) {
    const response = await fetch(`${this.baseUrl}/api/sanitize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });

    return await response.json();
  }

  async testConnection(service = 'gemini') {
    const response = await fetch(`${this.baseUrl}/api/test-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service })
    });

    return await response.json();
  }
}

// Usage example
const client = new PrivacyGuardianClient();

// Process with AI
client.processMessage(
  "Hi, I'm John Doe and my email is john@example.com",
  "gemini"
).then(result => {
  console.log(result.final_response);
});
```

## Best Practices

### 1. Error Handling
Always check the `status` field in responses:

```python
result = client.process_message("Hello")
if result["status"] == "success":
    # Process successful result
    print(result["final_response"])
else:
    # Handle error
    print(f"Error: {result['error']}")
```

### 2. Rate Limiting
Implement proper retry logic for rate limits:

```python
import time

def process_with_retry(client, message, max_retries=3):
    for attempt in range(max_retries):
        try:
            result = client.process_message(message)
            if result.get("status") == "success":
                return result
        except requests.exceptions.HTTPError as e:
            if e.response.status_code == 429:  # Rate limited
                time.sleep(60)  # Wait 1 minute
                continue
            raise
    raise Exception("Max retries exceeded")
```

### 3. Input Validation
Validate input size before sending:

```python
def safe_process_message(client, message):
    if len(message.encode('utf-8')) > 16 * 1024 * 1024:  # 16MB
        raise ValueError("Message too large")
    
    return client.process_message(message)
```

### 4. Health Monitoring
Regularly check service health:

```python
def check_service_health(client):
    try:
        status = requests.get(f"{client.base_url}/api/status")
        return status.json()["status"] == "running"
    except:
        return False
```

## OpenAPI Specification

The complete OpenAPI 3.0 specification is available at runtime via the `/openapi.json` endpoint (if enabled in configuration).