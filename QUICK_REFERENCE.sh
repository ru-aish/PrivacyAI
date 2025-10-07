#!/bin/bash
# Quick Reference for AI-Friendly Privacy Testing

cat << 'EOF'
╔══════════════════════════════════════════════════════════════════════╗
║              Privacy Guardian - AI Testing Quick Reference           ║
╚══════════════════════════════════════════════════════════════════════╝

📋 BASIC USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Single message (JSON):
    $ python3 prompt_analysis_api.py "my name is john"

  Pretty-printed:
    $ python3 prompt_analysis_api.py --pretty "test message"

  From stdin:
    $ echo "message" | python3 prompt_analysis_api.py --stdin

  Batch processing:
    $ python3 prompt_analysis_api.py --batch messages.txt -o results.json


🔍 EXTRACTING KEY INFORMATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Get protected prompt:
    $ python3 prompt_analysis_api.py "msg" | jq -r '.final_output.final_prompt'

  Count PII detected:
    $ python3 prompt_analysis_api.py "msg" | jq '.level2_ai_privacy.detections | length'

  Get processing time:
    $ python3 prompt_analysis_api.py "msg" | jq '.timing_summary.total_seconds'

  Check selected AI service:
    $ python3 prompt_analysis_api.py "msg" | jq -r '.level3_multi_ai_coordination.selected_service'

  List all detected PII:
    $ python3 prompt_analysis_api.py "msg" | jq '.level2_ai_privacy.detections[].privacy_type'


⚡ COMMON PATTERNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Test PII detection:
    for msg in "my name is john" "email: test@example.com" "SSN: 123-45-6789"; do
      echo "Testing: $msg"
      python3 prompt_analysis_api.py "$msg" | jq '.final_output.privacy_protected'
    done

  Benchmark performance:
    time python3 prompt_analysis_api.py --batch test_cases.txt -o /dev/null

  Find slow messages:
    python3 prompt_analysis_api.py --batch msgs.txt | \
      jq '.results[] | select(.timing_summary.total_seconds > 0.5) | .original_message'

  Export for spreadsheet:
    python3 prompt_analysis_api.py --batch msgs.txt | \
      jq -r '.results[] | [.original_message, .final_output.privacy_protected, .timing_summary.total_seconds] | @csv'


🧪 TESTING SCENARIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Create test file:
    cat > tests.txt << 'TESTS'
    my name is john smith
    contact me at john@email.com
    my SSN is 123-45-6789
    call me at 555-1234
    no pii in this message
    TESTS

  Run tests:
    python3 prompt_analysis_api.py --batch tests.txt --pretty

  Verify all PII detected:
    python3 prompt_analysis_api.py --batch tests.txt | \
      jq '.results[] | {msg: .original_message, protected: .final_output.privacy_protected}'


📊 OUTPUT STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  .metadata                              - Input characteristics
  .level1_basic_filter                   - Rule-based detection
  .level2_ai_privacy                     - AI privacy analysis
    .detections[]                        - List of detected PII
      .privacy_type                      - Type of PII (PERSON_NAME, EMAIL, etc)
      .original_text                     - Original sensitive text
      .replacement_text                  - Anonymized replacement
      .confidence                        - Detection confidence (0-1)
  .level3_multi_ai_coordination          - Service selection logic
    .selected_service                    - Chosen AI service
  .final_output                          - Final results
    .final_prompt                        - Protected prompt to send to AI
    .privacy_protected                   - Boolean: PII detected?
  .timing_summary                        - Performance metrics
    .total_seconds                       - Total processing time


💡 PRO TIPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  • Use --pretty for debugging, plain JSON for automation
  • Batch mode is 10x faster for multiple messages
  • Check timing_summary for performance bottlenecks
  • level2_ai_privacy.detections is the most important field
  • Service selection happens in level3_multi_ai_coordination
  • Set up jq for easy JSON parsing: apt install jq


🔗 RELATED FILES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ./prompt_analysis_api.py               - Main API script
  ./test_ai_friendly.sh                  - Comprehensive examples
  ./AI_TESTING_GUIDE.md                  - Detailed documentation
  ./run_terminal.sh                      - Start interactive terminal
  ./privacy_terminal.py                  - Terminal interface

EOF
