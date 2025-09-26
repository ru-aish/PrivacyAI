from typing import Dict, List, Tuple, Optional
from .detector import HybridDetector, DetectedEntity
from .ai_privacy_analyzer import AIPrivacyAnalyzer
import uuid
import json


class ProcessorResult:
    """Result of text processing operation."""
    
    def __init__(self, sanitized_text: str, session_map: Dict[str, str], 
                 original_text: str, entities: List[DetectedEntity]):
        self.sanitized_text = sanitized_text
        self.session_map = session_map
        self.original_text = original_text
        self.entities = entities
    
    def to_dict(self) -> Dict:
        """Convert result to dictionary for JSON serialization."""
        return {
            'sanitized_text': self.sanitized_text,
            'session_map': self.session_map,
            'original_text': self.original_text,
            'entities_count': len(self.entities)
        }


class PrivacyProcessor:
    """Main processor for sanitizing and de-sanitizing text."""
    
    def __init__(self, lm_studio_url: str = "http://localhost:1234", use_ai_analyzer: bool = True):
        self.detector = HybridDetector(lm_studio_url)
        self.ai_analyzer = AIPrivacyAnalyzer(lm_studio_url) if use_ai_analyzer else None
        self.entity_counters = {}
        self.use_ai_analyzer = use_ai_analyzer
    
    def _generate_placeholder(self, entity_type: str, text: str) -> str:
        """Generate a context-aware placeholder for an entity."""
        # Initialize counter for this entity type if not exists
        if entity_type not in self.entity_counters:
            self.entity_counters[entity_type] = 0
        
        self.entity_counters[entity_type] += 1
        counter = self.entity_counters[entity_type]
        
        # Generate context-aware placeholders
        placeholder_templates = {
            'EMAIL': '[EMAIL_ADDRESS]',
            'PHONE': '[PHONE_NUMBER]',
            'PERSON': '[PERSON_NAME]',
            'LOCATION': '[CITY_NAME]',
            'ORGANIZATION': '[COMPANY_NAME]',
            'IP_ADDRESS': '[IP_ADDRESS]',
            'CREDIT_CARD': '[CARD_NUMBER]',
            'SSN': '[SSN]',
            'URL': '[WEBSITE_URL]',
            'MISCELLANEOUS': '[SENSITIVE_INFO]'
        }
        
        base_placeholder = placeholder_templates.get(entity_type, f'[{entity_type}]')
        
        # Add counter if multiple entities of same type
        if counter > 1:
            return f"{base_placeholder[:-1]}_{counter}]"
        else:
            return base_placeholder
    
    def sanitize(self, text: str) -> ProcessorResult:
        """
        Sanitize text by replacing sensitive entities with placeholders.
        
        Uses AI-powered privacy analysis if available, falls back to traditional detection.
        
        Args:
            text: The original text to sanitize
            
        Returns:
            ProcessorResult containing sanitized text and session map
        """
        # Use AI-powered privacy analyzer if available
        if self.use_ai_analyzer and self.ai_analyzer:
            return self._sanitize_with_ai(text)
        else:
            return self._sanitize_with_traditional_detector(text)
    
    def _sanitize_with_ai(self, text: str) -> ProcessorResult:
        """Sanitize using AI-powered privacy analyzer."""
        ai_result = self.ai_analyzer.analyze_and_anonymize(text)
        
        # Convert AI detections to DetectedEntity format for compatibility
        entities = []
        for detection in ai_result['detections']:
            entity = DetectedEntity(
                text=detection.original_text,
                start=detection.start_pos,
                end=detection.end_pos,
                entity_type=detection.privacy_type,
                confidence=detection.confidence
            )
            entities.append(entity)
        
        return ProcessorResult(
            sanitized_text=ai_result['anonymized_text'],
            session_map=ai_result['session_map'],
            original_text=ai_result['original_text'],
            entities=entities
        )
    
    def _sanitize_with_traditional_detector(self, text: str) -> ProcessorResult:
        """Sanitize using traditional rule-based + NER detection."""
        # Reset counters for this session
        self.entity_counters = {}
        
        # Detect entities
        entities = self.detector.detect(text)
        
        if not entities:
            # No entities found, return original text
            return ProcessorResult(
                sanitized_text=text,
                session_map={},
                original_text=text,
                entities=[]
            )
        
        # Sort entities by start position in reverse order to avoid index shifting
        entities_sorted = sorted(entities, key=lambda x: x.start, reverse=True)
        
        sanitized_text = text
        session_map = {}
        
        # Replace entities with placeholders from end to beginning
        for entity in entities_sorted:
            placeholder = self._generate_placeholder(entity.entity_type, entity.text)
            
            # Replace the entity text in the sanitized text
            sanitized_text = (
                sanitized_text[:entity.start] + 
                placeholder + 
                sanitized_text[entity.end:]
            )
            
            # Store in session map for later de-sanitization
            session_map[placeholder] = entity.text
        
        return ProcessorResult(
            sanitized_text=sanitized_text,
            session_map=session_map,
            original_text=text,
            entities=entities
        )
    
    def desanitize(self, sanitized_text: str, session_map: Dict[str, str]) -> str:
        """
        De-sanitize text by replacing placeholders with original values.
        
        Args:
            sanitized_text: Text with placeholders
            session_map: Mapping of placeholders to original values
            
        Returns:
            Original text with sensitive data restored
        """
        desanitized_text = sanitized_text
        
        # Replace placeholders with original values
        for placeholder, original_value in session_map.items():
            desanitized_text = desanitized_text.replace(placeholder, original_value)
        
        return desanitized_text
    
    def process_full_cycle(self, user_input: str, ai_response: str, 
                          session_map: Dict[str, str]) -> str:
        """
        Process a complete cycle: sanitize input, get AI response, de-sanitize response.
        
        Args:
            user_input: Original user input (for context)
            ai_response: AI response to the sanitized input
            session_map: Session map from the sanitization step
            
        Returns:
            De-sanitized AI response
        """
        return self.desanitize(ai_response, session_map)
    
    def get_sensitivity_summary(self, entities: List[DetectedEntity]) -> Dict[str, int]:
        """
        Get a summary of detected sensitive entities by type.
        
        Args:
            entities: List of detected entities
            
        Returns:
            Dictionary with entity types and their counts
        """
        summary = {}
        for entity in entities:
            entity_type = entity.entity_type
            summary[entity_type] = summary.get(entity_type, 0) + 1
        
        return summary
    
    def validate_session_map(self, session_map: Dict[str, str]) -> bool:
        """
        Validate that a session map has the expected structure.
        
        Args:
            session_map: Session map to validate
            
        Returns:
            True if valid, False otherwise
        """
        if not isinstance(session_map, dict):
            return False
        
        for placeholder, value in session_map.items():
            if not isinstance(placeholder, str) or not isinstance(value, str):
                return False
            
            # Check if placeholder follows expected format
            if not (placeholder.startswith('[') and placeholder.endswith(']')):
                return False
        
        return True
    
    def export_session_data(self, result: ProcessorResult) -> str:
        """
        Export session data for debugging or analysis.
        
        Args:
            result: ProcessorResult to export
            
        Returns:
            JSON string of session data
        """
        export_data = {
            'original_text': result.original_text,
            'sanitized_text': result.sanitized_text,
            'session_map': result.session_map,
            'entities': [
                {
                    'text': entity.text,
                    'type': entity.entity_type,
                    'start': entity.start,
                    'end': entity.end,
                    'confidence': entity.confidence
                }
                for entity in result.entities
            ],
            'sensitivity_summary': self.get_sensitivity_summary(result.entities)
        }
        
        return json.dumps(export_data, indent=2)