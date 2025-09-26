"""
AI-Powered Privacy Analyzer - The Main Level Privacy Protection System

This is the core AI-powered privacy analysis system that:
1. Uses AI to intelligently detect ANY personal information in text
2. Creates smart anonymization with natural-sounding alternatives
3. Handles cultural names and context-dependent information
4. Makes intelligent decisions about what needs privacy protection
"""

import re
import requests
import json
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
from ..prompt_loader import prompt_loader


@dataclass
class PrivacyDetection:
    """Represents a privacy-sensitive item detected by AI."""
    original_text: str
    start_pos: int
    end_pos: int
    privacy_type: str  # PERSON_NAME, LOCATION, ORGANIZATION, etc.
    replacement_text: str  # AI-generated natural replacement
    confidence: float
    reasoning: str  # Why AI thinks this needs privacy protection


class AIPrivacyAnalyzer:
    """
    Main Level AI-Powered Privacy Protection System
    
    This uses AI to intelligently analyze text for ANY personal information
    and creates natural-sounding anonymization alternatives.
    """
    
    def __init__(self, lm_studio_url: str = "http://localhost:1234"):
        self.lm_studio_url = lm_studio_url
        self.session_cache = {}
        
    def analyze_privacy(self, text: str) -> List[PrivacyDetection]:
        """
        Use AI to analyze text for privacy-sensitive information.
        
        This is the main privacy protection method that:
        1. Identifies ALL personal information (not just structured data)
        2. Creates natural anonymization alternatives
        3. Handles cultural context and names intelligently
        
        Args:
            text: The text to analyze for privacy issues
            
        Returns:
            List of PrivacyDetection objects with smart replacements
        """
        
        if not self._is_ai_available():
            print("AI Privacy Analyzer not available - falling back to basic detection")
            return self._basic_fallback_detection(text)
        
        prompt = self._create_privacy_analysis_prompt(text)
        
        try:
            response = requests.post(
                f"{self.lm_studio_url}/v1/chat/completions",
                json={
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 1000
                },
                timeout=15
            )
            
            if response.status_code == 200:
                result = response.json()
                content = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                return self._parse_ai_privacy_response(content, text)
            else:
                print(f"AI Privacy Analyzer API error: {response.status_code}")
                return self._basic_fallback_detection(text)
                
        except Exception as e:
            print(f"AI Privacy Analyzer error: {e}")
            return self._basic_fallback_detection(text)
    
    def _create_privacy_analysis_prompt(self, text: str) -> str:
        """Create the AI prompt for privacy analysis."""
        return prompt_loader.get_privacy_analysis_prompt(text)

    def _parse_ai_privacy_response(self, ai_response: str, original_text: str) -> List[PrivacyDetection]:
        """Parse the AI response into PrivacyDetection objects."""
        try:
            # Clean the response to extract JSON
            ai_response = ai_response.strip()
            if ai_response.startswith('```json'):
                ai_response = ai_response[7:]
            if ai_response.endswith('```'):
                ai_response = ai_response[:-3]
            ai_response = ai_response.strip()
            
            detections_data = json.loads(ai_response)
            detections = []
            
            for item in detections_data:
                # Validate the positions against the original text
                start = item.get('start', 0)
                end = item.get('end', 0) 
                original = item.get('original', '')
                
                # Verify the positions are correct
                if start >= 0 and end <= len(original_text) and original_text[start:end] == original:
                    detection = PrivacyDetection(
                        original_text=original,
                        start_pos=start,
                        end_pos=end,
                        privacy_type=item.get('type', 'UNKNOWN'),
                        replacement_text=item.get('replacement', '[REDACTED]'),
                        confidence=item.get('confidence', 0.5),
                        reasoning=item.get('reasoning', 'Privacy protection')
                    )
                    detections.append(detection)
                else:
                    print(f"AI gave invalid positions for '{original}' at ({start}, {end})")
                    # Try to find the correct position
                    correct_start = original_text.find(original)
                    if correct_start != -1:
                        detection = PrivacyDetection(
                            original_text=original,
                            start_pos=correct_start,
                            end_pos=correct_start + len(original),
                            privacy_type=item.get('type', 'UNKNOWN'),
                            replacement_text=item.get('replacement', '[REDACTED]'),
                            confidence=item.get('confidence', 0.5) * 0.8,  # Lower confidence for position fix
                            reasoning=item.get('reasoning', 'Privacy protection (position corrected)')
                        )
                        detections.append(detection)
            
            return detections
            
        except (json.JSONDecodeError, KeyError, ValueError) as e:
            print(f"Error parsing AI privacy response: {e}")
            print(f"AI Response was: {ai_response}")
            return self._basic_fallback_detection(original_text)
    
    def _basic_fallback_detection(self, text: str) -> List[PrivacyDetection]:
        """Basic fallback when AI is not available."""
        detections = []
        
        # Basic name patterns (very simple fallback)
        name_patterns = [
            r'\b[A-Z][a-z]{2,}\b',  # Capitalized words that might be names
        ]
        
        for pattern in name_patterns:
            for match in re.finditer(pattern, text):
                # Skip common words
                word = match.group().lower()
                if word in ['the', 'and', 'but', 'for', 'are', 'this', 'that', 'with']:
                    continue
                    
                detection = PrivacyDetection(
                    original_text=match.group(),
                    start_pos=match.start(),
                    end_pos=match.end(),
                    privacy_type='PERSON_NAME',
                    replacement_text='[NAME]',
                    confidence=0.3,  # Low confidence for basic detection
                    reasoning='Basic pattern matching fallback'
                )
                detections.append(detection)
        
        return detections
    
    def _is_ai_available(self) -> bool:
        """Check if the AI privacy analyzer is available."""
        try:
            response = requests.get(f"{self.lm_studio_url}/v1/models", timeout=5)
            return response.status_code == 200
        except:
            return False
    
    def create_anonymized_text(self, text: str, detections: List[PrivacyDetection]) -> Tuple[str, Dict[str, str]]:
        """
        Create anonymized text using AI-generated natural replacements.
        
        Args:
            text: Original text
            detections: Privacy detections from analyze_privacy()
            
        Returns:
            Tuple of (anonymized_text, session_map)
        """
        if not detections:
            return text, {}
        
        # Sort detections by start position in reverse order
        detections_sorted = sorted(detections, key=lambda x: x.start_pos, reverse=True)
        
        anonymized_text = text
        session_map = {}
        
        # Replace from end to beginning to maintain positions
        for detection in detections_sorted:
            anonymized_text = (
                anonymized_text[:detection.start_pos] + 
                detection.replacement_text + 
                anonymized_text[detection.end_pos:]
            )
            
            # Store in session map for potential restoration
            session_map[detection.replacement_text] = detection.original_text
        
        return anonymized_text, session_map
    
    def analyze_and_anonymize(self, text: str) -> Dict:
        """
        Complete AI-powered privacy analysis and anonymization.
        
        Args:
            text: Original text to analyze and anonymize
            
        Returns:
            Dictionary with:
            - original_text: Original input
            - anonymized_text: AI-anonymized version
            - detections: List of what was found and replaced
            - session_map: Mapping for potential restoration
        """
        detections = self.analyze_privacy(text)
        anonymized_text, session_map = self.create_anonymized_text(text, detections)
        
        return {
            'original_text': text,
            'anonymized_text': anonymized_text,
            'detections': detections,
            'session_map': session_map,
            'ai_powered': self._is_ai_available()
        }


# Quick test function
def test_ai_privacy_analyzer():
    """Test the AI Privacy Analyzer with sample data."""
    analyzer = AIPrivacyAnalyzer()
    
    test_cases = [
        "so my name is rudra",
        "Hi, I'm Dr. Sarah Johnson from New York",
        "My friend dharm works at Google in Mumbai",
        "Contact me at john@example.com or call 555-123-4567"
    ]
    
    print("🧪 TESTING AI PRIVACY ANALYZER")
    print("=" * 50)
    
    for i, test_text in enumerate(test_cases, 1):
        print(f"\n📝 TEST {i}: {test_text}")
        result = analyzer.analyze_and_anonymize(test_text)
        
        print(f"🔍 Original:    {result['original_text']}")
        print(f"🛡️  Anonymized:  {result['anonymized_text']}")
        print(f"🤖 AI Powered:   {result['ai_powered']}")
        
        if result['detections']:
            print("📋 Detections:")
            for d in result['detections']:
                print(f"   • {d.original_text} → {d.replacement_text} ({d.privacy_type}, {d.confidence:.2f})")
        else:
            print("✅ No privacy issues detected")


if __name__ == "__main__":
    test_ai_privacy_analyzer()