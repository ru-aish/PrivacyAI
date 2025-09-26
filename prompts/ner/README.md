# Named Entity Recognition (NER) Prompts

This folder contains prompts for basic named entity recognition using local LM Studio models.

## Basic NER Prompt
- File: `basic_ner.txt`
- Purpose: Extract named entities (PERSON, LOCATION, ORGANIZATION)
- Temperature: 0.1
- Max tokens: 500
- Output: JSON array with positions and types

## Usage
Used by the HybridDetector for basic entity detection when full AI privacy analysis is not needed or unavailable.