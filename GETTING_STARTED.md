# Getting Started - AI-Friendly Testing

## Quick Start (30 seconds)

```bash
# 1. Validate the API works
python3 validate_api.py

# 2. Try a simple analysis
python3 prompt_analysis_api.py --pretty "my name is john"

# 3. Done! You're ready to use it.
```

## What You Can Do

### Analyze a Single Message
```bash
# JSON output (for automation)
python3 prompt_analysis_api.py "my name is john"

# Pretty JSON (for humans)
python3 prompt_analysis_api.py --pretty "contact: john@email.com"
```

### Batch Process Messages
```bash
# Create test file
cat > messages.txt << EOF
my name is john
contact john@email.com
SSN is 123-45-6789
EOF

# Process all messages
python3 prompt_analysis_api.py --batch messages.txt --pretty
```

### Use in Terminal
```bash
# Start interactive terminal
./run_terminal.sh

# Then inside terminal:
/prompt-analysis my name is john
/prompt-analysis --json test message
```

### Use Convenient Wrapper
```bash
./test.sh analyze "my name is john"
./test.sh analyze-pretty "test message"
./test.sh validate
./test.sh examples
```

## Understanding the Output

When you run:
```bash
python3 prompt_analysis_api.py --pretty "my name is john"
```

You get JSON with these key fields:

```json
{
  "level2_ai_privacy": {
    "detections": [...]           ← What PII was found
  },
  "final_output": {
    "final_prompt": "...",        ← Protected prompt to use
    "privacy_protected": true     ← Was PII detected?
  },
  "timing_summary": {
    "total_seconds": 0.25         ← How long it took
  }
}
```

## Common Use Cases

### Testing PII Detection
```bash
# Test various PII types
for msg in "my name is john" "email: test@example.com" "SSN: 123-45-6789"; do
  echo "Testing: $msg"
  python3 prompt_analysis_api.py "$msg" | jq '.final_output.privacy_protected'
done
```

### Getting the Protected Prompt
```bash
# Extract just the protected prompt
protected=$(python3 prompt_analysis_api.py "my name is john" | jq -r '.final_output.final_prompt')
echo "Send this to AI: $protected"
```

### Checking Performance
```bash
# Get processing time
python3 prompt_analysis_api.py "test" | jq '.timing_summary.total_seconds'

# Benchmark batch processing
time python3 prompt_analysis_api.py --batch large_file.txt -o /dev/null
```

## Next Steps

### See Working Examples
```bash
./test_ai_friendly.sh
```

### View Quick Reference
```bash
./QUICK_REFERENCE.sh
```

### Read Full Guide
```bash
cat AI_TESTING_GUIDE.md
# or
./test.sh guide
```

### View All Changes
```bash
cat CHANGES.md
```

## Integration Example

### Python
```python
import subprocess
import json

def analyze(message):
    result = subprocess.run(
        ['python3', 'prompt_analysis_api.py', message],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)

# Use it
data = analyze("my name is john")
print(f"Protected: {data['final_output']['final_prompt']}")
print(f"Had PII: {data['final_output']['privacy_protected']}")
```

### Shell Script
```bash
#!/bin/bash

# Analyze and extract protected prompt
analyze_and_protect() {
    local message="$1"
    python3 prompt_analysis_api.py "$message" | \
        jq -r '.final_output.final_prompt'
}

# Use it
protected=$(analyze_and_protect "my name is john")
echo "Protected prompt: $protected"
```

## Troubleshooting

### API Not Found
```bash
# Make sure you're in the right directory
cd /home/rudra/Code/privacyAI/pv
python3 prompt_analysis_api.py "test"
```

### Import Errors
```bash
# The API needs to be run from the pv directory
cd /home/rudra/Code/privacyAI/pv
python3 prompt_analysis_api.py "test"
```

### Slow Performance
```bash
# Check if LM Studio is running (optional but faster)
curl http://localhost:1234/v1/models

# The system will work without it, just slower
```

## Help Commands

```bash
# API help
python3 prompt_analysis_api.py --help

# Test wrapper help
./test.sh help

# Terminal help
./run_terminal.sh
# Then type: /help
```

## Files Reference

- `prompt_analysis_api.py` - Main API script
- `AI_TESTING_GUIDE.md` - Comprehensive documentation
- `QUICK_REFERENCE.sh` - Quick command reference
- `test_ai_friendly.sh` - Working examples
- `validate_api.py` - Validation tests
- `test.sh` - Convenience wrapper
- `CHANGES.md` - Complete changelog

## Summary

You now have a powerful, AI-friendly testing interface for privacy analysis!

**One-liner to test everything:**
```bash
python3 validate_api.py && echo "✅ All systems ready!"
```

**Most common command:**
```bash
python3 prompt_analysis_api.py --pretty "your test message here"
```

**For automation:**
```bash
python3 prompt_analysis_api.py "message" | jq '.final_output.final_prompt'
```

That's it! You're ready to go. 🚀
