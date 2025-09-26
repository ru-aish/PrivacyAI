# 🛡️ Privacy Guardian Terminal Interface

## Quick Start

```bash
# Navigate to the project directory
cd privacy-guardian-gateway

# Run the interactive terminal
python privacy_terminal.py
# OR use the launcher script
./run_terminal.sh
```

## What It Does

The terminal interface lets you:

1. **Enter any message** with personal information
2. **See exactly what PII is detected** and protected
3. **View the safe message** with PII replaced by placeholders  
4. **Get AI responses** (optional) with your PII safely restored
5. **Test privacy protection** in real-time

## Example Session

```
Privacy Guardian> Hi, I'm John Doe and my email is john@example.com

🔍 ANALYZING MESSAGE FOR PII...
✅ PRIVACY ANALYSIS COMPLETE

📝 ORIGINAL MESSAGE:
   Hi, I'm John Doe and my email is john@example.com

🚨 PII DETECTED & PROTECTED:
   • PERSON_NAME: John Doe
   • EMAIL_ADDRESS: john@example.com

🛡️  SAFE MESSAGE (PII REMOVED):
   Hi, I'm PLACEHOLDER_PERSON_NAME and my email is PLACEHOLDER_EMAIL_ADDRESS

🤖 SENDING TO AI (LM_STUDIO)...
🤖 AI RESPONSE (WITH PLACEHOLDERS):
   Hello PLACEHOLDER_PERSON_NAME! I'd be happy to help you...

✨ FINAL RESPONSE (PII RESTORED):
   Hello John Doe! I'd be happy to help you...
```

## Available Commands

- `/help` - Show all commands
- `/settings` - View current configuration  
- `/ai <service>` - Switch between gemini/lm_studio
- `/system <prompt>` - Set system prompt for AI
- `/toggle-ai` - Enable/disable AI responses
- `/test` - Run a demo example
- `/history` - View your session history
- `/clear` - Clear session history
- `/quit` - Exit the terminal

## Features

- **🎨 Colorized Output**: Easy to read with color-coded sections
- **🔒 Real-time Privacy Protection**: See exactly what PII is detected
- **🤖 AI Integration**: Optional AI responses with Gemini or LM Studio
- **📊 Session History**: Keep track of your interactions
- **⚙️ Configurable**: Switch AI services, set system prompts
- **🧪 Built-in Testing**: Test examples to see how it works

## Privacy Types Detected

The terminal will show you when it finds:
- Person names (John Doe, Dr. Smith)
- Email addresses (user@example.com)
- Phone numbers (555-123-4567)
- Addresses (123 Main St)
- Credit card numbers
- Social Security Numbers
- And 10+ other PII types

## Try These Examples

```
> My name is Sarah Johnson and I live at 456 Oak Avenue
> Please call me at +1-555-987-6543 about my account
> Send the report to manager@company.com by Friday
> My credit card number is 4532-1234-5678-9012
> Contact Dr. Michael Brown at his office: 212-555-0199
```

The terminal will show you exactly what gets protected and how!

## Tips

- Use `/test` to see a comprehensive example
- Try `/toggle-ai` to see just the privacy protection without AI
- Use `/system` to set custom instructions for the AI
- Check `/settings` to see which AI services are working