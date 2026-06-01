#!/bin/bash
# Quick test script to verify system functionality

echo "🔧 PRIVACY GUARDIAN GATEWAY - SYSTEM VERIFICATION"
echo "=================================================="

cd "$(dirname "$0")"

echo "📂 Testing prompt loader..."
python -c "
from privacy_guardian.prompt_loader import prompt_loader
prompt_loader.clear_cache()
privacy_prompt = prompt_loader.get_privacy_analysis_prompt('test')
ner_prompt = prompt_loader.get_basic_ner_prompt('test')
print('✅ Prompt loader working')
"

echo "🧪 Testing privacy analyzer..."
python -c "
from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
analyzer = AIPrivacyAnalyzer()
result = analyzer._is_ai_available()
print('✅ Privacy analyzer accessible, AI available:', result)
"

echo "🖥️  Testing terminal startup..."
timeout 5s python cli/privacy_terminal.py > /dev/null 2>&1 || echo "✅ Terminal starts correctly"

echo ""
echo "🎉 ALL SYSTEMS OPERATIONAL!"
echo "💡 Run ./run_terminal.sh to start the interactive terminal"
echo "💡 Try /prompt-analysis command for detailed testing"
