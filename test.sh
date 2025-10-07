#!/bin/bash

# Convenience wrapper for Privacy Guardian testing
# Provides easy access to all testing features

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

show_help() {
    cat << 'EOF'
Privacy Guardian - Testing Commands
====================================

Quick Test Commands:
  ./test.sh analyze "message"          - Analyze a single message (JSON)
  ./test.sh analyze-pretty "message"   - Analyze with pretty JSON
  ./test.sh batch <file>               - Batch analyze messages from file
  ./test.sh validate                   - Run validation tests
  ./test.sh examples                   - Show working examples
  ./test.sh reference                  - Show quick reference
  ./test.sh terminal                   - Start interactive terminal

Examples:
  ./test.sh analyze "my name is john"
  ./test.sh analyze-pretty "contact john@email.com"
  ./test.sh validate
  ./test.sh terminal

Documentation:
  ./test.sh guide                      - View full testing guide
  ./test.sh summary                    - View implementation summary

EOF
}

case "$1" in
    analyze)
        shift
        python3 prompt_analysis_api.py "$@"
        ;;
    
    analyze-pretty)
        shift
        python3 prompt_analysis_api.py --pretty "$@"
        ;;
    
    batch)
        shift
        python3 prompt_analysis_api.py --batch "$@"
        ;;
    
    validate)
        python3 validate_api.py
        ;;
    
    examples)
        ./test_ai_friendly.sh
        ;;
    
    reference)
        ./QUICK_REFERENCE.sh
        ;;
    
    terminal)
        ./run_terminal.sh
        ;;
    
    guide)
        if command -v less &> /dev/null; then
            less AI_TESTING_GUIDE.md
        else
            cat AI_TESTING_GUIDE.md
        fi
        ;;
    
    summary)
        if command -v less &> /dev/null; then
            less AI_TESTING_SUMMARY.md
        else
            cat AI_TESTING_SUMMARY.md
        fi
        ;;
    
    help|--help|-h|"")
        show_help
        ;;
    
    *)
        echo "Unknown command: $1"
        echo ""
        show_help
        exit 1
        ;;
esac
