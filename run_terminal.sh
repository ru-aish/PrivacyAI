#!/bin/bash

# Privacy Guardian Gateway - Gemini Integration with Privacy Protection
# Interactive terminal with complete AI response pipeline

echo "🛡️  PRIVACY GUARDIAN GATEWAY - GEMINI PREFERRED"
echo "================================================"
echo "🧠 AI-Powered Privacy Protection System"
echo "🚀 Gemini API Preferred with Local Fallback"
echo "🔒 Your data is sanitized BEFORE being sent to cloud"
echo ""

# Check if we're in the right directory
if [ ! -f "privacy_terminal.py" ]; then
    echo "❌ Error: privacy_terminal.py not found"
    echo "💡 Please run this script from the privacy-guardian-gateway directory"
    exit 1
fi

# Check if Python dependencies are available
python3 -c "import privacy_guardian.sanitizer.processor" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "❌ Error: Privacy Guardian modules not found"
    echo "💡 Please make sure you're in the correct directory and dependencies are installed"
    exit 1
fi

# Check if AI services are available
echo "🔍 Checking AI service availability..."

# Check LM Studio
python3 -c "
from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
analyzer = AIPrivacyAnalyzer()
if analyzer._is_ai_available():
    print('✅ LM Studio (Privacy Analysis): Connected')
else:
    print('⚠️  LM Studio: Not available (will use basic fallback)')
" 2>/dev/null

# Check Gemini API
python3 -c "
import os
from dotenv import load_dotenv
load_dotenv()
api_key = os.getenv('GEMINI_API_KEY')
if api_key and len(api_key) > 10:
    print('✅ Gemini API: Key configured')
    from privacy_guardian.ai_client import AIServiceManager
    manager = AIServiceManager()
    result = manager.test_connection('gemini')
    if result['status'] == 'success':
        print('✅ Gemini API: Connected and responding')
    else:
        print('⚠️  Gemini API: Key set but connection failed')
        print('   Error:', result.get('error', 'Unknown'))
else:
    print('❌ Gemini API: Key not configured in .env file')
    print('   Add: GEMINI_API_KEY=your_key_here')
" 2>/dev/null

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎯 INTELLIGENT AI ROUTING WITH PRIVACY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📋 HOW IT WORKS:"
echo "  🚀 PREFERRED: Gemini API (Cloud)"
echo "     1️⃣  Your prompt: 'My name is Alice, email alice@email.com'"
echo "     2️⃣  LM Studio sanitizes: 'My name is PERSON_1, email EMAIL_1'"
echo "     3️⃣  Gemini responds (with placeholders)"
echo "     4️⃣  System restores: 'Hello Alice! ..alice@email.com..'"
echo "     ✅ Personal info NEVER sent to cloud!"
echo ""
echo "  🏠 FALLBACK: LM Studio (Local) - if Gemini unavailable"
echo "     1️⃣  Original prompt sent directly to local model"
echo "     2️⃣  No anonymization needed (stays on your machine)"
echo "     3️⃣  Response generated locally"
echo "     ✅ Everything private and local!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🚀 QUICK START OPTIONS:"
echo "  • Just type any message to see it in action!"
echo "  • Try: 'My name is John, I live in NYC. Tell me a joke.'"
echo "  • Try: 'I'm Sarah, email sarah@test.com. Help me write a bio.'"
echo ""
echo "📖 COMMANDS:"
echo "  /help             - Show all commands"
echo "  /settings         - View current configuration and service status"
echo "  /demo             - Interactive demo with your own message"
echo "  /test             - Run automated test examples"
echo "  /ai gemini        - Force Gemini service"
echo "  /ai lm_studio     - Force LM Studio service"
echo "  /ai auto          - Auto-select best service"
echo ""
echo "🔬 TESTING & ANALYSIS:"
echo "  /filter-test      - Interactive filter testing (shows all levels)"
echo "  /prompt-analysis  - Detailed analysis with timing data"
echo "  /coord-test       - Test multi-AI coordination system"
echo ""
echo "💡 EXAMPLES TO TRY:"
echo "  python3 example_gemini_integration.py    # Simple interactive example"
echo "  python3 test_gemini_integration.py       # Automated test suite"
echo ""

# Launch the terminal interface
python3 privacy_terminal.py