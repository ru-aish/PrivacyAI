import re
import requests
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
from ..prompt_loader import prompt_loader


@dataclass
class DetectedEntity:
    """Represents a detected sensitive entity in text."""
    text: str
    start: int
    end: int
    entity_type: str
    confidence: float = 1.0


class RuleBasedDetector:
    """Rule-based detector using regex patterns for structured sensitive data."""
    
    def __init__(self):
        self.patterns = {
            'EMAIL': re.compile(
                r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
            ),
            'PHONE': re.compile(
                r'(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}'
            ),
            'IP_ADDRESS': re.compile(
                r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b'
            ),
            'CREDIT_CARD': re.compile(
                r'\b(?:\d{4}[-\s]?){3}\d{4}\b'
            ),
            'SSN': re.compile(
                r'\b\d{3}-\d{2}-\d{4}\b'
            ),
            'URL': re.compile(
                r'https?://(?:[-\w.])+(?:\:[0-9]+)?(?:/(?:[\w/_.])*(?:\?(?:[\w&=%.])*)?(?:\#(?:[\w.])*)?)?'
            )
        }
    
    def detect(self, text: str) -> List[DetectedEntity]:
        """Detect structured sensitive data using regex patterns."""
        entities = []
        
        for entity_type, pattern in self.patterns.items():
            for match in pattern.finditer(text):
                entities.append(DetectedEntity(
                    text=match.group(),
                    start=match.start(),
                    end=match.end(),
                    entity_type=entity_type,
                    confidence=1.0  # Rule-based detection has high confidence
                ))
        
        # Sort by start position
        entities.sort(key=lambda x: x.start)
        return entities


class LocalModelDetector:
    """Detector that uses a local NER model served by LM Studio."""
    
    def __init__(self, lm_studio_url: str = "http://localhost:1234"):
        self.lm_studio_url = lm_studio_url
        self.entity_mapping = {
            'PERSON': 'PERSON',
            'PER': 'PERSON',
            'GPE': 'LOCATION',  # Geopolitical entities
            'LOC': 'LOCATION',
            'ORG': 'ORGANIZATION',
            'MISC': 'MISCELLANEOUS'
        }
    
    def detect(self, text: str) -> List[DetectedEntity]:
        """Detect entities using the local model via LM Studio API."""
        try:
            # Prepare the prompt for NER task
            prompt = prompt_loader.get_basic_ner_prompt(text)
            
            response = requests.post(
                f"{self.lm_studio_url}/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 500
                },
                timeout=10
            )
            
            if response.status_code == 200:
                result = response.json()
                content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                
                # Parse the JSON response
                try:
                    import json
                    entities_data = json.loads(content.strip())
                    
                    entities = []
                    for entity_data in entities_data:
                        entity_type = self.entity_mapping.get(
                            entity_data.get('type', '').upper(), 
                            entity_data.get('type', 'UNKNOWN')
                        )
                        
                        entities.append(DetectedEntity(
                            text=entity_data.get('text', ''),
                            start=entity_data.get('start', 0),
                            end=entity_data.get('end', 0),
                            entity_type=entity_type,
                            confidence=0.8  # Local model confidence
                        ))
                    
                    return entities
                    
                except (json.JSONDecodeError, KeyError, TypeError) as e:
                    print(f"Error parsing local model response: {e}")
                    return []
            else:
                print(f"Local model API error: {response.status_code}")
                return []
                
        except requests.exceptions.RequestException as e:
            print(f"Failed to connect to local model: {e}")
            return []
    
    def is_available(self) -> bool:
        """Check if the local model is available."""
        try:
            response = requests.get(f"{self.lm_studio_url}/v1/models", timeout=5)
            return response.status_code == 200
        except requests.exceptions.RequestException:
            return False


class HybridDetector:
    """Combines rule-based and local model detection for comprehensive coverage."""
    
    def __init__(self, lm_studio_url: str = "http://localhost:1234"):
        self.rule_detector = RuleBasedDetector()
        self.local_detector = LocalModelDetector(lm_studio_url)
    
    def detect(self, text: str) -> List[DetectedEntity]:
        """Detect entities using both rule-based and local model approaches."""
        all_entities = []
        
        # Get rule-based detections (high confidence, structured data)
        rule_entities = self.rule_detector.detect(text)
        all_entities.extend(rule_entities)
        
        # Get local model detections (for unstructured entities like names)
        if self.local_detector.is_available():
            model_entities = self.local_detector.detect(text)
            
            # Filter out overlapping entities (prefer rule-based for overlaps)
            for model_entity in model_entities:
                overlaps = False
                for rule_entity in rule_entities:
                    if (model_entity.start < rule_entity.end and 
                        model_entity.end > rule_entity.start):
                        overlaps = True
                        break
                
                if not overlaps:
                    all_entities.append(model_entity)
        else:
            print("Warning: Local model not available, using only rule-based detection")
        
        # Sort by start position and remove duplicates
        all_entities.sort(key=lambda x: x.start)
        return self._remove_duplicates(all_entities)
    
    def _remove_duplicates(self, entities: List[DetectedEntity]) -> List[DetectedEntity]:
        """Remove duplicate entities that overlap significantly."""
        if not entities:
            return entities
        
        unique_entities = [entities[0]]
        
        for entity in entities[1:]:
            last_entity = unique_entities[-1]
            
            # Check for significant overlap (>50% of either entity)
            overlap_start = max(entity.start, last_entity.start)
            overlap_end = min(entity.end, last_entity.end)
            overlap_length = max(0, overlap_end - overlap_start)
            
            entity_length = entity.end - entity.start
            last_entity_length = last_entity.end - last_entity.start
            
            overlap_ratio_entity = overlap_length / entity_length if entity_length > 0 else 0
            overlap_ratio_last = overlap_length / last_entity_length if last_entity_length > 0 else 0
            
            # If overlap is significant, keep the one with higher confidence
            if overlap_ratio_entity > 0.5 or overlap_ratio_last > 0.5:
                if entity.confidence > last_entity.confidence:
                    unique_entities[-1] = entity
            else:
                unique_entities.append(entity)
        
        return unique_entities