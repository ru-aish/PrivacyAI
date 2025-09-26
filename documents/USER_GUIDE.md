# Privacy Guardian Gateway - User Guide

## Overview

The Privacy Guardian Gateway is a privacy-first AI interaction system that automatically detects and removes personally identifiable information (PII) from your messages before sending them to AI services, then restores the information in the responses.

## Key Features

- **🛡️ Privacy Protection**: Automatically detects and removes 15+ types of PII
- **🤖 Multi-AI Support**: Works with Google Gemini and LM Studio
- **🌐 Web Interface**: Easy-to-use web application
- **📱 API Access**: RESTful API for integration
- **🔒 Security First**: Rate limiting, input validation, and secure deployment

## Getting Started

### Web Interface

1. **Access the Application**
   - Open your browser and navigate to `http://localhost:5000`
   - In production: `https://yourdomain.com`

2. **Using the Interface**
   - Enter your message in the text area
   - Optionally add a system prompt for the AI
   - Select your preferred AI service (Gemini or LM Studio)
   - Click "Send Message"

3. **Understanding the Results**
   - **Sanitized Message**: Your message with PII removed
   - **AI Response**: The AI's response to the sanitized message
   - **Final Response**: AI response with your PII restored
   - **Privacy Items**: List of PII types that were detected

### API Usage

#### 1. Process Message with AI

**Endpoint**: `POST /api/process`

**Request**:
```json
{
  "message": "Hi, I'm John Doe and my email is john@example.com. Can you help me?",
  "ai_service": "gemini",
  "system_prompt": "You are a helpful assistant."
}
```

**Response**:
```json
{
  "status": "success",
  "sanitized_message": "Hi, I'm PLACEHOLDER_PERSON_NAME and my email is PLACEHOLDER_EMAIL_ADDRESS. Can you help me?",
  "ai_response": "Hello PLACEHOLDER_PERSON_NAME! I'd be happy to help you...",
  "final_response": "Hello John Doe! I'd be happy to help you...",
  "privacy_items_detected": ["PERSON_NAME", "EMAIL_ADDRESS"],
  "ai_service_used": "gemini"
}
```

#### 2. Sanitize Only (No AI)

**Endpoint**: `POST /api/sanitize`

**Request**:
```json
{
  "message": "My phone number is 555-123-4567 and I live at 123 Main St."
}
```

**Response**:
```json
{
  "status": "success",
  "original_message": "My phone number is 555-123-4567 and I live at 123 Main St.",
  "sanitized_message": "My phone number is PLACEHOLDER_PHONE_NUMBER and I live at PLACEHOLDER_ADDRESS.",
  "privacy_items_detected": ["PHONE_NUMBER", "ADDRESS"],
  "replacements": {
    "PHONE_NUMBER": "555-123-4567",
    "ADDRESS": "123 Main St"
  }
}
```

#### 3. Test AI Connection

**Endpoint**: `POST /api/test-connection`

**Request**:
```json
{
  "service": "gemini"
}
```

**Response**:
```json
{
  "status": "success",
  "service": "gemini",
  "message": "Connection successful"
}
```

#### 4. Get Service Status

**Endpoint**: `GET /api/status`

**Response**:
```json
{
  "status": "running",
  "default_ai_service": "gemini",
  "services": {
    "gemini": {"status": "success", "message": "Connected"},
    "lm_studio": {"status": "error", "message": "Connection failed"}
  },
  "privacy_processor": "operational"
}
```

## Privacy Protection Details

### Supported PII Types

The system automatically detects and protects:

1. **Personal Information**
   - Person names (John Doe, Jane Smith)
   - Email addresses (user@example.com)
   - Phone numbers (555-123-4567, +1-555-123-4567)

2. **Financial Information**
   - Credit card numbers (4532-1234-5678-9012)
   - Social Security Numbers (123-45-6789)
   - Bank account numbers

3. **Location Information**
   - Street addresses (123 Main St, Apt 4B)
   - IP addresses (192.168.1.1)
   - Geographic coordinates

4. **Identity Documents**
   - Driver's license numbers
   - Passport numbers
   - National ID numbers

5. **Digital Identifiers**
   - Usernames (@johndoe)
   - URLs with personal info
   - API keys and tokens

### How It Works

1. **Detection**: Advanced pattern matching identifies PII in your text
2. **Replacement**: PII is replaced with secure placeholders
3. **AI Processing**: Only the sanitized text is sent to the AI service
4. **Restoration**: Original PII is restored in the AI's response
5. **Security**: No PII is ever stored or logged

## Configuration

### Environment Variables

```bash
# AI Services
GEMINI_API_KEY=your-api-key-here
LM_STUDIO_BASE_URL=http://localhost:1234/v1
DEFAULT_AI_SERVICE=gemini

# Security
RATE_LIMIT_PER_MINUTE=60
MAX_CONTENT_LENGTH=16777216  # 16MB
REQUIRE_HTTPS=false  # Set to true in production

# Application
FLASK_PORT=5000
FLASK_DEBUG=false
```

### AI Service Setup

#### Google Gemini
1. Get API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Set `GEMINI_API_KEY` in your environment
3. Select "gemini" as your AI service

#### LM Studio
1. Install and run [LM Studio](https://lmstudio.ai/)
2. Load a model and start the local server
3. Set `LM_STUDIO_BASE_URL` (default: http://localhost:1234/v1)
4. Select "lm_studio" as your AI service

## Best Practices

### For Users

1. **Review Results**: Always check the sanitized message to ensure privacy
2. **System Prompts**: Use clear system prompts for better AI responses
3. **Service Selection**: Choose the AI service based on your needs:
   - Gemini: Cloud-based, fast, advanced capabilities
   - LM Studio: Local, private, customizable models

### For Developers

1. **Error Handling**: Always check the `status` field in API responses
2. **Rate Limits**: Respect the 60 requests/minute limit (configurable)
3. **Input Validation**: API validates input, but clean data improves results
4. **Security**: Use HTTPS in production environments

## Common Use Cases

### 1. Customer Support
```json
{
  "message": "Hi, I'm Sarah Johnson (sarah.j@email.com) and I need help with my order #12345.",
  "system_prompt": "You are a helpful customer support agent."
}
```

### 2. Document Review
```json
{
  "message": "Please review this contract for John Smith at 456 Oak Ave, phone: 555-987-6543.",
  "system_prompt": "You are a legal document reviewer. Focus on key terms and conditions."
}
```

### 3. Data Analysis
```json
{
  "message": "Analyze this customer feedback: 'Jane Doe (jane@company.com) from Seattle loves the product!'",
  "system_prompt": "You are a data analyst. Provide insights on customer sentiment."
}
```

## Troubleshooting

### Common Issues

#### 1. AI Service Not Available
- **Error**: `"error": "AI service unavailable"`
- **Solution**: Check your API keys and service configuration
- **Test**: Use `/api/test-connection` endpoint

#### 2. Rate Limit Exceeded
- **Error**: `"error": "Rate limit exceeded"`
- **Solution**: Wait 1 minute or reduce request frequency
- **Configure**: Adjust `RATE_LIMIT_PER_MINUTE` if needed

#### 3. Request Too Large
- **Error**: `"error": "Request too large"`
- **Solution**: Reduce message size (max 16MB)
- **Configure**: Adjust `MAX_CONTENT_LENGTH` if needed

#### 4. Invalid JSON
- **Error**: `"error": "Content-Type must be application/json"`
- **Solution**: Ensure request has `Content-Type: application/json` header

### Getting Help

1. **Check Status**: Use `/api/status` to verify service health
2. **Review Logs**: Check application logs for detailed error information
3. **Test Connection**: Use `/api/test-connection` for AI service issues
4. **Validate Input**: Ensure your JSON is properly formatted

## API Response Codes

- `200` - Success
- `400` - Bad Request (invalid input)
- `401` - Unauthorized (missing/invalid token)
- `413` - Request Too Large
- `429` - Rate Limit Exceeded
- `500` - Internal Server Error
- `503` - Service Unavailable

## Privacy Guarantees

- **No Storage**: PII is never stored permanently
- **In-Memory Only**: Replacements exist only during request processing
- **No Logging**: PII is never written to log files
- **Secure Transit**: HTTPS encryption in production
- **Local Processing**: Privacy detection happens locally

## Security Features

- **Rate Limiting**: Prevents abuse (60 req/min per IP)
- **Input Validation**: Prevents malicious input
- **Secure Headers**: Security headers on all responses
- **Error Sanitization**: Error messages don't leak sensitive info
- **Health Monitoring**: Secure health check endpoints

## Performance Expectations

- **Response Time**: 3-7 seconds (depending on AI service and model)
- **Throughput**: 60 requests/minute per IP address
- **Privacy Detection**: <100ms for typical messages
- **Memory Usage**: Minimal - no persistent storage

## Support

For technical support:
1. Check the `/api/status` endpoint
2. Review application logs
3. Verify environment configuration
4. Test with simple examples first