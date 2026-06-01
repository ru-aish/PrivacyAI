# Privacy Guardian - AI-Friendly Testing API

## Overview

The Privacy Guardian system now provides an AI-friendly API for automated testing and integration. This allows AI systems, automated testing frameworks, and CI/CD pipelines to easily analyze privacy protection effectiveness.

## Quick Start

### Basic Usage

```bash
# Analyze a single message
python3 prompt_analysis_api.py "my name is rudra"

# Pretty-printed output
python3 prompt_analysis_api.py --pretty "my name is john"

# From stdin (useful for piping)
echo "test message" | python3 prompt_analysis_api.py --stdin

# Batch analysis from file
python3 prompt_analysis_api.py --batch messages.txt --output results.json
```

### Within Terminal

```bash
# Direct command
/prompt-analysis my name is john

# JSON output mode
/prompt-analysis --json test message
```

## Output Format

The API returns structured JSON with comprehensive analysis:

```json
{
  "metadata": {
    "timestamp": "2025-10-07T...",
    "input_length": 18,
    "word_count": 4,
    "character_analysis": {
      "letters": 14,
      "digits": 0,
      "spaces": 3,
      "special": 1
    }
  },
  "level1_basic_filter": {
    "processing_time_seconds": 0.001,
    "entities_detected": [...],
    "sanitized_text": "..."
  },
  "level2_ai_privacy": {
    "processing_time_seconds": 0.235,
    "detections": [
      {
        "privacy_type": "PERSON_NAME",
        "original_text": "rudra",
        "replacement_text": "PERSON_1",
        "confidence": 0.95,
        "reasoning": "..."
      }
    ],
    "anonymized_text": "my name is PERSON_1"
  },
  "level3_multi_ai_coordination": {
    "processing_time_seconds": 0.015,
    "request_type": "general_chat",
    "privacy_sensitive": true,
    "estimated_complexity": 0.3,
    "selected_service": "lm_studio",
    "service_scores": {
      "lm_studio": 0.85,
      "gemini": 0.42
    }
  },
  "final_output": {
    "selected_service": "lm_studio",
    "final_prompt": "my name is PERSON_1",
    "privacy_protected": true
  },
  "timing_summary": {
    "level1_seconds": 0.001,
    "level2_seconds": 0.235,
    "level3_seconds": 0.015,
    "total_seconds": 0.251,
    "processing_speed_chars_per_second": 71.7
  }
}
```

## Key Fields for AI Systems

### For Privacy Testing
- `level2_ai_privacy.detections[]` - List of detected PII
- `final_output.privacy_protected` - Boolean indicating if PII was found
- `final_output.final_prompt` - The protected prompt to send to AI services

### For Performance Monitoring
- `timing_summary.level2_seconds` - AI privacy analysis time
- `timing_summary.total_seconds` - End-to-end processing time
- `timing_summary.processing_speed_chars_per_second` - Throughput metric

### For Service Selection
- `level3_multi_ai_coordination.selected_service` - Which AI service was chosen
- `level3_multi_ai_coordination.service_scores` - Capability scores for each service
- `level3_multi_ai_coordination.request_type` - Detected request type

## Integration Examples

### Python Integration

```python
import json
import subprocess

def analyze_privacy(message):
    """Analyze a message through privacy filters"""
    result = subprocess.run(
        ['python3', 'prompt_analysis_api.py', message],
        capture_output=True,
        text=True
    )
    return json.loads(result.stdout)

# Use it
analysis = analyze_privacy("my name is rudra")
print(f"Protected prompt: {analysis['final_output']['final_prompt']}")
print(f"PII detected: {len(analysis['level2_ai_privacy']['detections'])}")
```

### Bash/Shell Integration

```bash
# Extract just the protected prompt
protected_prompt=$(python3 prompt_analysis_api.py "my name is john" | jq -r '.final_output.final_prompt')

# Check if PII was detected
pii_count=$(python3 prompt_analysis_api.py "test" | jq '.level2_ai_privacy.detections | length')

# Batch process and check timing
python3 prompt_analysis_api.py --batch messages.txt | jq '.results[].timing_summary.total_seconds'
```

### CI/CD Integration

```yaml
# Example GitHub Actions workflow
- name: Test Privacy Protection
  run: |
    python3 prompt_analysis_api.py --batch test_cases.txt --output results.json
    
    # Verify all PII was detected
    jq '.results[] | select(.final_output.privacy_protected == false)' results.json
    
    # Check performance threshold (< 0.5s per message)
    jq '.results[] | select(.timing_summary.total_seconds > 0.5)' results.json
```

## Test Cases for AI Systems

### Privacy Detection Test Cases

Create a file `privacy_test_cases.txt`:
```
my name is john smith
contact me at john@email.com
my SSN is 123-45-6789
I live at 123 Main Street, New York
call me at +1-555-123-4567
my credit card is 4532-1234-5678-9010
```

Run tests:
```bash
python3 prompt_analysis_api.py --batch privacy_test_cases.txt --pretty
```

### Performance Benchmarking

```bash
# Time 100 analyses
time for i in {1..100}; do 
  python3 prompt_analysis_api.py "test message $i" > /dev/null
done

# Get average timing from batch
python3 prompt_analysis_api.py --batch messages.txt | \
  jq '.results[].timing_summary.total_seconds' | \
  awk '{sum+=$1} END {print "Average:", sum/NR, "seconds"}'
```

## Command Line Options

```
usage: prompt_analysis_api.py [-h] [--json] [--pretty] [--human] [--stdin]
                               [--batch FILE] [--output FILE]
                               [message]

positional arguments:
  message               Message to analyze

optional arguments:
  -h, --help            Show help message
  --json                Output JSON format (default)
  --pretty              Pretty-print JSON output
  --human               Human-readable output
  --stdin               Read message from stdin
  --batch FILE          Analyze messages from file (one per line)
  --output FILE, -o FILE
                        Write results to file
```

## Best Practices for AI Testing

1. **Validate PII Detection**: Check that all expected PII types are detected
   ```bash
   result=$(python3 prompt_analysis_api.py "my name is john")
   echo $result | jq '.level2_ai_privacy.detections[].privacy_type'
   ```

2. **Monitor Performance**: Track processing time across test suite
   ```bash
   python3 prompt_analysis_api.py --batch tests.txt | \
     jq '.results[] | {msg: .original_message, time: .timing_summary.total_seconds}'
   ```

3. **Verify Service Selection**: Ensure correct AI service is chosen
   ```bash
   python3 prompt_analysis_api.py "write python code" | \
     jq '.level3_multi_ai_coordination.selected_service'
   ```

4. **Test Edge Cases**: Use batch mode for comprehensive coverage
   ```bash
   # Create edge case file
   cat > edge_cases.txt << EOF
   empty pii message with no personal info
   mixed: john@email.com with 123-45-6789
   unicode: café résumé naïve
   symbols: !@#$%^&*()
   EOF
   
   python3 prompt_analysis_api.py --batch edge_cases.txt --pretty
   ```

## Troubleshooting

### Import Errors
```bash
# Ensure you're in the correct directory
cd /home/rudra/Code/privacyAI/pv
python3 prompt_analysis_api.py "test"
```

### LM Studio Connection
```bash
# Check if LM Studio is running
curl http://localhost:1234/v1/models

# The API will fallback gracefully if unavailable
```

### Performance Issues
```bash
# Monitor timing for slow queries
python3 prompt_analysis_api.py "long message..." | \
  jq '.timing_summary'
```

## Advanced Usage

### Custom Analysis Pipeline

```python
from prompt_analysis_api import analyze_prompt

# Analyze with custom logic
def custom_pipeline(messages):
    results = []
    for msg in messages:
        analysis = analyze_prompt(msg)
        
        # Custom validation
        if analysis['level2_ai_privacy']['detections']:
            print(f"⚠️  PII found in: {msg}")
        
        # Performance check
        if analysis['timing_summary']['total_seconds'] > 1.0:
            print(f"⚠️  Slow analysis: {msg}")
        
        results.append(analysis)
    
    return results
```

### Integration with Testing Frameworks

```python
import pytest
from prompt_analysis_api import analyze_prompt

class TestPrivacyProtection:
    @pytest.mark.parametrize("message,expected_pii", [
        ("my name is john", True),
        ("hello world", False),
        ("email: test@example.com", True),
    ])
    def test_pii_detection(self, message, expected_pii):
        result = analyze_prompt(message)
        has_pii = len(result['level2_ai_privacy']['detections']) > 0
        assert has_pii == expected_pii
    
    def test_performance_threshold(self):
        result = analyze_prompt("test message")
        assert result['timing_summary']['total_seconds'] < 0.5
```

## Support

For issues or questions:
- Check logs in the terminal output
- Verify LM Studio is running for AI-powered analysis
- Ensure all dependencies are installed
- See `./run_terminal.sh` for environment setup
