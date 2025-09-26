# Privacy Analysis Prompt

This prompt is used by the AI Privacy Analyzer to detect personal information and create natural anonymization replacements.

## Purpose
- Detects ALL personal information (names, locations, organizations, etc.)
- Handles cultural names from all backgrounds
- Creates natural replacements that maintain context
- Returns structured JSON with exact positions

## Usage
- Temperature: 0.1 (consistent results)
- Max tokens: 1000
- Model: LM Studio local model

## Output Format
Returns JSON array with detected privacy items including:
- original text
- character positions  
- privacy type
- natural replacement
- confidence score
- reasoning