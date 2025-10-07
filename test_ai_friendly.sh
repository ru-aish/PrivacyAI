#!/bin/bash

# AI-Friendly Privacy Analysis Testing Examples
# This script demonstrates how to use the prompt analysis API for automated testing

echo "🤖 Privacy Guardian - AI-Friendly Testing Examples"
echo "=================================================="
echo ""

# Example 1: Simple single message analysis (JSON)
echo "📋 Example 1: Single message analysis (compact JSON)"
echo "$ python3 prompt_analysis_api.py 'my name is rudra'"
echo ""
python3 prompt_analysis_api.py 'my name is rudra'
echo ""
echo "---"
echo ""

# Example 2: Pretty-printed JSON for readability
echo "📋 Example 2: Pretty-printed JSON output"
echo "$ python3 prompt_analysis_api.py --pretty 'contact me at john@email.com'"
echo ""
python3 prompt_analysis_api.py --pretty 'contact me at john@email.com'
echo ""
echo "---"
echo ""

# Example 3: Using from stdin (for piping)
echo "📋 Example 3: Reading from stdin"
echo "$ echo 'My friend dharm works at Google' | python3 prompt_analysis_api.py --stdin --pretty"
echo ""
echo 'My friend dharm works at Google' | python3 prompt_analysis_api.py --stdin --pretty
echo ""
echo "---"
echo ""

# Example 4: Batch processing
echo "📋 Example 4: Batch processing multiple messages"
echo "Creating test file with multiple messages..."

cat > /tmp/test_messages.txt << EOF
my name is rudra
contact john@email.com for more info
My SSN is 123-45-6789
I live at 123 Main St, New York
Call me at 555-1234
EOF

echo "$ python3 prompt_analysis_api.py --batch /tmp/test_messages.txt --output /tmp/batch_results.json"
python3 prompt_analysis_api.py --batch /tmp/test_messages.txt --output /tmp/batch_results.json
echo ""
echo "Results saved to /tmp/batch_results.json"
echo ""
echo "---"
echo ""

# Example 5: Using within the terminal
echo "📋 Example 5: Using /prompt-analysis within terminal"
echo "$ echo '/prompt-analysis my name is john' | python3 privacy_terminal.py"
echo "(Note: This runs interactively, so output may vary)"
echo ""

# Example 6: Extract specific fields using jq
echo "📋 Example 6: Extract specific analysis fields using jq"
echo "$ python3 prompt_analysis_api.py 'test message' | jq '.final_output'"
echo ""
if command -v jq &> /dev/null; then
    python3 prompt_analysis_api.py 'my name is rudra' | jq '.final_output'
else
    echo "(jq not installed, showing full output)"
    python3 prompt_analysis_api.py 'my name is rudra'
fi
echo ""
echo "---"
echo ""

# Clean up
rm -f /tmp/test_messages.txt

echo "✅ All examples completed!"
echo ""
echo "💡 Integration Tips for AI Systems:"
echo "  1. Use --json or --pretty for structured output"
echo "  2. Parse the 'final_output' field for the protected prompt"
echo "  3. Check 'level2_ai_privacy.detections' for PII found"
echo "  4. Monitor 'timing_summary' for performance metrics"
echo "  5. Use batch mode for testing multiple scenarios"
echo ""
echo "📚 Output Structure:"
echo "  - metadata: Input characteristics"
echo "  - level1_basic_filter: Rule-based detection results"
echo "  - level2_ai_privacy: AI-powered privacy analysis"
echo "  - level3_multi_ai_coordination: Service selection"
echo "  - final_output: Final protected prompt to send to AI"
echo "  - timing_summary: Performance metrics"
