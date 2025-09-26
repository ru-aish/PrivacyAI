# 🧪 Interactive Testing Mode Demo

## New Interactive Testing Features

The Privacy Guardian Gateway now includes powerful interactive testing modes that show exactly how your prompts are processed through different privacy filter levels **WITHOUT** sending anything to AI services.

### 🔬 `/filter-test` - Interactive Filter Testing

This mode shows your input processed through all three filter levels:

1. **Level 1: Basic Rule-Based Detection** (regex patterns)
2. **Level 2: AI-Powered Privacy Analysis** (intelligent detection)  
3. **Level 3: Multi-AI Coordination** (service selection)

**Example Session:**
```
Privacy Guardian> /filter-test
🔬 Enter test message: My name is John Smith and my SSN is 123-45-6789

📝 ORIGINAL INPUT:
   My name is John Smith and my SSN is 123-45-6789
   Length: 47 characters

🔍 FILTER LEVEL 1: BASIC RULE-BASED DETECTION
   ⏱️  Processing Time: 1.177s
   📋 Basic Patterns Detected:
   • PERSON: John Smith
   • SSN: 123-45-6789
   📤 Level 1 Output: My n[PERSON_NAME] Smit[SSN_2]SN is [SSN]

🧠 FILTER LEVEL 2: AI-POWERED PRIVACY ANALYSIS
   ⏱️  Processing Time: 2.731s
   🎯 AI Privacy Detections:
   • PERSON_NAME: John Smith → Alex Johnson (Confidence: 0.76)
   • SSN: 123-45-6789 → XXX-XX-XXXX (Confidence: 0.76)
   📤 Level 2 Output: My name is Alex Johnson and my SSN is XXX-XX-XXXX

🚀 FILTER LEVEL 3: MULTI-AI COORDINATION
   ⏱️  Processing Time: 0.000s
   📊 Request Type: general_chat
   🔒 Privacy Sensitive: True
   🎯 Complexity: 0.40
   🤖 Selected Service: LM_STUDIO
   📈 Service Scores:
   👑 LM_STUDIO: 0.70
      GEMINI: 0.90

📊 PROCESSING SUMMARY:
   🕐 Level 1 (Basic): 1.177s
   🕑 Level 2 (AI Privacy): 2.731s  
   🕒 Level 3 (Coordination): 0.000s
   🕓 Total Processing: 3.908s

📤 FINAL PROMPT (What would be sent to AI):
   Service: LM_STUDIO
   Prompt: "My name is Alex Johnson and my SSN is XXX-XX-XXXX"
   ⚠️  NOTE: This prompt is NOT actually sent to any AI service
```

### 📊 `/prompt-analysis` - Detailed Prompt Analysis

This mode provides comprehensive analysis with metadata and performance metrics:

**Example Session:**
```
Privacy Guardian> /prompt-analysis
📊 Enter message: Write a Python function to sort emails by sender name

📋 ANALYSIS METADATA:
   🕐 Timestamp: 2025-09-25 12:54:38
   📏 Input Length: 53 characters
   📝 Word Count: 10
   🔤 Character Types: Letters: 44, Digits: 0, Spaces: 9, Special: 0

[... full filter analysis ...]

🔬 ANALYSIS METRICS:
   ⏱️  Total Analysis Time: 0.694s
   🚀 Processing Speed: 76.4 chars/second
   💾 Memory Impact: Minimal (stateless processing)
```

## Key Benefits

### 🛡️ **Perfect for Testing Privacy Protection:**
- See exactly what privacy items are detected at each level
- Compare basic regex vs AI-powered detection
- Verify sensitive data is properly anonymized
- No risk of accidentally sending data to AI services

### ⚡ **Performance Analysis:**
- Precise timing for each filter level
- Processing speed metrics
- Character composition analysis
- Total system performance overview

### 🎯 **Service Selection Testing:**
- See how different prompts are categorized
- Understand service selection logic
- Compare capability scores across services
- Test coordination algorithm decisions

### 🔬 **Interactive & Safe:**
- Test any input without AI service calls
- Immediate feedback on privacy protection
- Step-by-step filter level breakdown
- Perfect for demonstrations and audits

## Usage Tips

1. **Test Privacy-Sensitive Data:**
   ```
   /filter-test
   My email is user@company.com and phone is 555-1234
   ```

2. **Test Different Request Types:**
   ```
   /prompt-analysis
   Write me a creative story about dragons
   ```

3. **Compare Filter Effectiveness:**
   - Try inputs that basic regex might miss
   - See how AI detection catches subtle privacy issues
   - Understand when coordination affects service selection

4. **Performance Testing:**
   - Test with different input lengths
   - Compare processing times
   - Analyze character composition effects

## Commands Summary

- `/filter-test` - Interactive filter testing showing all 3 levels
- `/prompt-analysis` - Detailed analysis with comprehensive metrics  
- `/help` - Shows all available commands
- `/settings` - Current system status and capabilities

These new testing modes make the Privacy Guardian Gateway perfect for:
- 🔒 Privacy compliance auditing
- 📊 Performance analysis  
- 🧪 System demonstration
- 🎓 Educational purposes
- 🔬 Research and development