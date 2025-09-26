#!/bin/bash

# Privacy Guardian Gateway - Multi-Level Privacy System Demo
# Interactive terminal demonstrating AI-powered privacy protection

echo "🛡️  PRIVACY GUARDIAN GATEWAY - MULTI-LEVEL DEMO"
echo "================================================"
echo "🧠 AI-Powered Privacy Protection System"
echo "🔒 Demonstrates Level 1, Main Level, and Context-Aware processing"
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
python3 -c "
from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
analyzer = AIPrivacyAnalyzer()
if analyzer._is_ai_available():
    print('✅ LM Studio AI: Connected')
else:
    print('⚠️  LM Studio AI: Not available (will use basic fallback)')
"

echo ""
echo "🚀 QUICK START OPTIONS:"
echo "  • Type any message to see multi-level privacy analysis"
echo "  • Try: 'so my name is rudra'"
echo "  • Try: 'My friend dharm works at Google in Mumbai'"
echo "  • Use /test for automated examples"
echo "  • Use /demo for interactive demo"
echo "  • Use /help for all commands"
echo ""

# Launch the terminal interface
python3 privacy_terminal.py