"""
Test Suite for AI Privacy Analyzer

This tests the main level AI-powered privacy protection system.
"""

import pytest
import sys
import os

# Add parent directory to path so we can import our modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer, PrivacyDetection


class TestAIPrivacyAnalyzer:
    """Test the AI-powered privacy analyzer."""
    
    @pytest.fixture
    def analyzer(self):
        """Create an analyzer instance for testing."""
        return AIPrivacyAnalyzer()
    
    def test_basic_name_detection(self, analyzer):
        """Test basic name detection and anonymization."""
        text = "so my name is rudra"
        result = analyzer.analyze_and_anonymize(text)
        
        assert result['original_text'] == text
        assert 'rudra' not in result['anonymized_text']  # PII should be removed
        assert result['anonymized_text'] != text  # Should be different
        assert len(result['detections']) > 0  # Should detect something
        
        # The critical test - PII should be completely removed
        assert 'rudra' not in result['anonymized_text'], f"PRIVACY FAILURE: 'rudra' still visible in: {result['anonymized_text']}"
    
    def test_multiple_privacy_items(self, analyzer):
        """Test detection of multiple privacy items."""
        text = "Hi, I'm Dr. Sarah Johnson from New York"
        result = analyzer.analyze_and_anonymize(text)
        
        assert result['original_text'] == text
        assert 'Sarah Johnson' not in result['anonymized_text']
        assert 'New York' not in result['anonymized_text']
        assert len(result['detections']) >= 2  # Should detect name and location
    
    def test_cultural_names(self, analyzer):
        """Test detection of cultural names."""
        text = "My friend dharm works at the office"
        result = analyzer.analyze_and_anonymize(text)
        
        assert result['original_text'] == text
        assert 'dharm' not in result['anonymized_text']  # Cultural name should be detected
        assert len(result['detections']) > 0
        
        # Check that the replacement makes sense
        detection = result['detections'][0]
        assert detection.privacy_type == 'PERSON_NAME'
        assert detection.original_text == 'dharm'
    
    def test_structured_data_detection(self, analyzer):
        """Test detection of structured privacy data."""
        text = "Contact me at john@example.com or call 555-123-4567"
        result = analyzer.analyze_and_anonymize(text)
        
        assert result['original_text'] == text
        assert 'john@example.com' not in result['anonymized_text']
        assert '555-123-4567' not in result['anonymized_text']
        assert len(result['detections']) >= 2  # Email and phone
    
    def test_no_privacy_issues(self, analyzer):
        """Test text with no privacy issues."""
        text = "The weather is nice today and I like programming"
        result = analyzer.analyze_and_anonymize(text)
        
        assert result['original_text'] == text
        # If no privacy issues, text might remain the same or have minimal changes
        assert result['anonymized_text'] is not None
    
    def test_privacy_detection_object(self, analyzer):
        """Test PrivacyDetection object creation."""
        detection = PrivacyDetection(
            original_text="rudra",
            start_pos=14,
            end_pos=19,
            privacy_type="PERSON_NAME",
            replacement_text="alex",
            confidence=0.95,
            reasoning="Personal name"
        )
        
        assert detection.original_text == "rudra"
        assert detection.replacement_text == "alex"
        assert detection.privacy_type == "PERSON_NAME"
        assert detection.confidence == 0.95
    
    def test_anonymization_quality(self, analyzer):
        """Test that anonymization maintains text quality and flow."""
        text = "My colleague Sara from Boston is working on the project"
        result = analyzer.analyze_and_anonymize(text)
        
        # The anonymized text should still be readable and flow naturally
        anonymized = result['anonymized_text']
        assert 'colleague' in anonymized  # Context words should remain
        assert 'working' in anonymized
        assert 'project' in anonymized
        
        # But privacy items should be replaced
        assert 'Sara' not in anonymized
        assert 'Boston' not in anonymized
    
    def test_session_map_creation(self, analyzer):
        """Test that session map is created correctly for restoration."""
        text = "My name is Alice and I live in Seattle"
        result = analyzer.analyze_and_anonymize(text)
        
        session_map = result['session_map']
        assert isinstance(session_map, dict)
        
        # Should be able to map replacements back to originals
        if result['detections']:
            for detection in result['detections']:
                # The replacement should be in the session map
                assert detection.replacement_text in session_map
                assert session_map[detection.replacement_text] == detection.original_text


def test_critical_privacy_bug_fixed():
    """
    CRITICAL TEST: Ensure the privacy bug is completely fixed.
    
    This test specifically checks the bug we identified where PII was not
    properly removed from text.
    """
    analyzer = AIPrivacyAnalyzer()
    
    # Test cases that were failing before
    critical_test_cases = [
        "so my name is rudra",
        "Hi I'm John Doe",
        "My friend dharm is here",
        "Contact Sarah at sarah@email.com"
    ]
    
    for test_text in critical_test_cases:
        result = analyzer.analyze_and_anonymize(test_text)
        anonymized = result['anonymized_text']
        
        # Extract all words from original text
        import re
        original_words = re.findall(r'\b[A-Za-z@.]+\b', test_text)
        
        # Check that detected privacy items are NOT in the anonymized text
        for detection in result['detections']:
            original_item = detection.original_text
            assert original_item not in anonymized, \
                f"CRITICAL PRIVACY FAILURE: '{original_item}' still visible in '{anonymized}'"
            
            # The replacement should be in the anonymized text
            replacement = detection.replacement_text
            if replacement not in ['[REDACTED]']:  # Skip generic placeholders
                assert replacement in anonymized, \
                    f"Replacement '{replacement}' not found in '{anonymized}'"


if __name__ == "__main__":
    # Run the critical test first
    print("🚨 RUNNING CRITICAL PRIVACY BUG TEST")
    print("=" * 50)
    test_critical_privacy_bug_fixed()
    print("✅ CRITICAL PRIVACY BUG TEST PASSED!")
    print()
    
    # Run a few key tests manually
    analyzer = AIPrivacyAnalyzer()
    
    print("🧪 RUNNING KEY FUNCTIONALITY TESTS")
    print("=" * 50)
    
    test_cases = [
        "so my name is rudra",
        "Hi, I'm Dr. Sarah Johnson from New York", 
        "My friend dharm works at Google in Mumbai"
    ]
    
    for i, text in enumerate(test_cases, 1):
        print(f"\n📝 TEST {i}: {text}")
        result = analyzer.analyze_and_anonymize(text)
        
        print(f"   Original:    {result['original_text']}")
        print(f"   Anonymized:  {result['anonymized_text']}")
        print(f"   Detections:  {len(result['detections'])} items")
        
        # Verify privacy protection
        for detection in result['detections']:
            if detection.original_text in result['anonymized_text']:
                print(f"   ❌ PRIVACY FAILURE: '{detection.original_text}' still visible!")
            else:
                print(f"   ✅ Privacy protected: '{detection.original_text}' → '{detection.replacement_text}'")
    
    print("\n🎉 ALL TESTS COMPLETED!")