import pytest
import sys
import os

# Add the parent directory to the path so we can import our modules
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../')))

from privacy_guardian.sanitizer.processor import PrivacyProcessor, ProcessorResult
from privacy_guardian.sanitizer.detector import DetectedEntity


class TestPrivacyProcessor:
    """Test cases for the PrivacyProcessor class."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.processor = PrivacyProcessor()
    
    def test_sanitize_email(self):
        """Test sanitization of email addresses."""
        text = "Please contact me at john.doe@example.com"
        result = self.processor.sanitize(text)
        
        assert isinstance(result, ProcessorResult)
        assert "[EMAIL_ADDRESS]" in result.sanitized_text
        assert "john.doe@example.com" not in result.sanitized_text
        assert "[EMAIL_ADDRESS]" in result.session_map
        assert result.session_map["[EMAIL_ADDRESS]"] == "john.doe@example.com"
    
    def test_sanitize_multiple_emails(self):
        """Test sanitization of multiple email addresses."""
        text = "Contact john@example.com or jane@test.com"
        result = self.processor.sanitize(text)
        
        assert "[EMAIL_ADDRESS]" in result.sanitized_text
        assert "[EMAIL_ADDRESS_2]" in result.sanitized_text
        assert len(result.session_map) == 2
    
    def test_sanitize_phone_number(self):
        """Test sanitization of phone numbers."""
        text = "Call me at 555-123-4567"
        result = self.processor.sanitize(text)
        
        assert "[PHONE_NUMBER]" in result.sanitized_text
        assert "555-123-4567" not in result.sanitized_text
        assert result.session_map["[PHONE_NUMBER]"] == "555-123-4567"
    
    def test_sanitize_mixed_entities(self):
        """Test sanitization of mixed entity types."""
        text = "Contact John at john@example.com or call 555-123-4567"
        result = self.processor.sanitize(text)
        
        # Should detect at least email and phone
        assert len(result.session_map) >= 2
        assert any("[EMAIL_ADDRESS]" in key for key in result.session_map.keys())
        assert any("[PHONE_NUMBER]" in key for key in result.session_map.keys())
    
    def test_sanitize_no_entities(self):
        """Test sanitization of text with no sensitive entities."""
        text = "This is a normal sentence with no sensitive information."
        result = self.processor.sanitize(text)
        
        assert result.sanitized_text == text
        assert len(result.session_map) == 0
        assert len(result.entities) == 0
    
    def test_desanitize_simple(self):
        """Test de-sanitization of simple text."""
        sanitized_text = "Please contact [EMAIL_ADDRESS] for more info."
        session_map = {"[EMAIL_ADDRESS]": "john@example.com"}
        
        result = self.processor.desanitize(sanitized_text, session_map)
        
        assert result == "Please contact john@example.com for more info."
    
    def test_desanitize_multiple_placeholders(self):
        """Test de-sanitization with multiple placeholders."""
        sanitized_text = "Contact [EMAIL_ADDRESS] or call [PHONE_NUMBER]"
        session_map = {
            "[EMAIL_ADDRESS]": "john@example.com",
            "[PHONE_NUMBER]": "555-123-4567"
        }
        
        result = self.processor.desanitize(sanitized_text, session_map)
        
        assert "john@example.com" in result
        assert "555-123-4567" in result
        assert "[EMAIL_ADDRESS]" not in result
        assert "[PHONE_NUMBER]" not in result
    
    def test_full_cycle_processing(self):
        """Test complete sanitize -> AI response -> desanitize cycle."""
        original_input = "My name is John and my email is john@example.com"
        
        # Sanitize
        result = self.processor.sanitize(original_input)
        sanitized = result.sanitized_text
        
        # Simulate AI response that uses the placeholders
        ai_response = f"Thank you for contacting us, {sanitized}. We will respond soon."
        
        # Desanitize the AI response
        final_response = self.processor.process_full_cycle(
            original_input, ai_response, result.session_map
        )
        
        assert "john@example.com" in final_response
        # Check that placeholders are replaced in AI response
        for placeholder in result.session_map.keys():
            assert placeholder not in final_response
    
    def test_generate_placeholder_uniqueness(self):
        """Test that placeholders are unique for multiple entities of same type."""
        text = "Email john@example.com and jane@test.com"
        result = self.processor.sanitize(text)
        
        placeholders = list(result.session_map.keys())
        assert len(placeholders) == 2
        assert len(set(placeholders)) == 2  # All unique
        assert "[EMAIL_ADDRESS]" in placeholders
        assert "[EMAIL_ADDRESS_2]" in placeholders
    
    def test_context_aware_placeholders(self):
        """Test that placeholders are context-aware."""
        text = "Contact john@example.com at 192.168.1.1 or visit https://example.com"
        result = self.processor.sanitize(text)
        
        placeholders = list(result.session_map.keys())
        expected_patterns = ["[EMAIL_ADDRESS]", "[IP_ADDRESS]", "[WEBSITE_URL]"]
        
        for expected in expected_patterns:
            assert any(expected in placeholder for placeholder in placeholders)
    
    def test_get_sensitivity_summary(self):
        """Test sensitivity summary generation."""
        entities = [
            DetectedEntity("john@example.com", 0, 16, "EMAIL", 1.0),
            DetectedEntity("555-123-4567", 20, 32, "PHONE", 1.0),
            DetectedEntity("jane@test.com", 40, 53, "EMAIL", 1.0)
        ]
        
        summary = self.processor.get_sensitivity_summary(entities)
        
        assert summary["EMAIL"] == 2
        assert summary["PHONE"] == 1
        assert len(summary) == 2
    
    def test_validate_session_map_valid(self):
        """Test validation of valid session map."""
        valid_map = {
            "[EMAIL_ADDRESS]": "john@example.com",
            "[PHONE_NUMBER]": "555-123-4567"
        }
        
        assert self.processor.validate_session_map(valid_map) is True
    
    def test_validate_session_map_invalid(self):
        """Test validation of invalid session maps."""
        invalid_maps = [
            "not a dict",
            {"invalid_key": "value"},  # No brackets
            {123: "value"},  # Non-string key
            {"[VALID_KEY]": 123},  # Non-string value
        ]
        
        for invalid_map in invalid_maps:
            assert self.processor.validate_session_map(invalid_map) is False
    
    def test_export_session_data(self):
        """Test session data export functionality."""
        text = "Email john@example.com"
        result = self.processor.sanitize(text)
        
        export_json = self.processor.export_session_data(result)
        
        assert isinstance(export_json, str)
        
        # Parse JSON to verify structure
        import json
        data = json.loads(export_json)
        
        assert "original_text" in data
        assert "sanitized_text" in data
        assert "session_map" in data
        assert "entities" in data
        assert "sensitivity_summary" in data
        
        assert data["original_text"] == text
        assert len(data["entities"]) >= 1
    
    def test_empty_text_handling(self):
        """Test handling of empty text."""
        result = self.processor.sanitize("")
        
        assert result.sanitized_text == ""
        assert len(result.session_map) == 0
        assert len(result.entities) == 0


class TestProcessorResult:
    """Test cases for the ProcessorResult class."""
    
    def test_processor_result_creation(self):
        """Test ProcessorResult creation."""
        entities = [DetectedEntity("test@example.com", 0, 16, "EMAIL", 1.0)]
        result = ProcessorResult(
            sanitized_text="Contact [EMAIL_ADDRESS]",
            session_map={"[EMAIL_ADDRESS]": "test@example.com"},
            original_text="Contact test@example.com",
            entities=entities
        )
        
        assert result.sanitized_text == "Contact [EMAIL_ADDRESS]"
        assert result.session_map["[EMAIL_ADDRESS]"] == "test@example.com"
        assert result.original_text == "Contact test@example.com"
        assert len(result.entities) == 1
    
    def test_to_dict_conversion(self):
        """Test conversion to dictionary."""
        entities = [DetectedEntity("test@example.com", 0, 16, "EMAIL", 1.0)]
        result = ProcessorResult(
            sanitized_text="Contact [EMAIL_ADDRESS]",
            session_map={"[EMAIL_ADDRESS]": "test@example.com"},
            original_text="Contact test@example.com",
            entities=entities
        )
        
        data = result.to_dict()
        
        assert isinstance(data, dict)
        assert data["sanitized_text"] == "Contact [EMAIL_ADDRESS]"
        assert data["session_map"]["[EMAIL_ADDRESS]"] == "test@example.com"
        assert data["original_text"] == "Contact test@example.com"
        assert data["entities_count"] == 1


class TestEdgeCases:
    """Test edge cases and error conditions."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.processor = PrivacyProcessor()
    
    def test_text_with_only_sensitive_data(self):
        """Test text that is entirely sensitive data."""
        text = "john@example.com"
        result = self.processor.sanitize(text)
        
        assert result.sanitized_text == "[EMAIL_ADDRESS]"
        assert len(result.session_map) == 1
    
    def test_overlapping_entities_handling(self):
        """Test handling of potentially overlapping entities."""
        # This might happen if rule-based and model-based detectors find overlapping entities
        text = "Contact John Smith at john.smith@company.com"
        result = self.processor.sanitize(text)
        
        # Should handle gracefully without duplicates
        assert len(result.session_map) >= 1
        assert result.sanitized_text != text  # Should be modified
    
    def test_special_characters_in_entities(self):
        """Test entities with special characters."""
        text = "Email: user+tag@sub-domain.co.uk"
        result = self.processor.sanitize(text)
        
        assert "[EMAIL_ADDRESS]" in result.sanitized_text
        assert result.session_map["[EMAIL_ADDRESS]"] == "user+tag@sub-domain.co.uk"
    
    def test_desanitize_with_missing_placeholders(self):
        """Test de-sanitization when session map is incomplete."""
        sanitized_text = "Contact [EMAIL_ADDRESS] and [PHONE_NUMBER]"
        incomplete_map = {"[EMAIL_ADDRESS]": "john@example.com"}  # Missing phone
        
        result = self.processor.desanitize(sanitized_text, incomplete_map)
        
        # Should replace what it can and leave the rest
        assert "john@example.com" in result
        assert "[PHONE_NUMBER]" in result  # This placeholder remains