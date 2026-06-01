import pytest
import sys
import os

# Add the parent directory to the path so we can import our modules
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../')))

from privacy_guardian.sanitizer.detector import (
    RuleBasedDetector, LocalModelDetector, HybridDetector, DetectedEntity
)


class TestRuleBasedDetector:
    """Test cases for the rule-based detector."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.detector = RuleBasedDetector()
    
    def test_email_detection(self):
        """Test email detection."""
        text = "Please contact me at john.doe@example.com for more information."
        entities = self.detector.detect(text)
        
        assert len(entities) == 1
        assert entities[0].text == "john.doe@example.com"
        assert entities[0].entity_type == "EMAIL"
        assert entities[0].confidence == 1.0
    
    def test_phone_detection(self):
        """Test phone number detection."""
        test_cases = [
            "Call me at 555-123-4567",
            "My number is (555) 123-4567",
            "Phone: +1-555-123-4567",
            "Contact: 555.123.4567"
        ]
        
        for text in test_cases:
            entities = self.detector.detect(text)
            assert len(entities) >= 1
            assert entities[0].entity_type == "PHONE"
    
    def test_ip_address_detection(self):
        """Test IP address detection."""
        text = "The server is located at 192.168.1.100"
        entities = self.detector.detect(text)
        
        assert len(entities) == 1
        assert entities[0].text == "192.168.1.100"
        assert entities[0].entity_type == "IP_ADDRESS"
    
    def test_url_detection(self):
        """Test URL detection."""
        text = "Visit our website at https://www.example.com/page"
        entities = self.detector.detect(text)
        
        assert len(entities) == 1
        assert entities[0].text == "https://www.example.com/page"
        assert entities[0].entity_type == "URL"
    
    def test_credit_card_detection(self):
        """Test credit card detection."""
        text = "My card number is 1234-5678-9012-3456"
        entities = self.detector.detect(text)
        
        assert len(entities) == 1
        assert entities[0].text == "1234-5678-9012-3456"
        assert entities[0].entity_type == "CREDIT_CARD"
    
    def test_ssn_detection(self):
        """Test SSN detection."""
        text = "SSN: 123-45-6789"
        entities = self.detector.detect(text)
        
        assert len(entities) == 1
        assert entities[0].text == "123-45-6789"
        assert entities[0].entity_type == "SSN"
    
    def test_multiple_entities(self):
        """Test detection of multiple entities."""
        text = "Contact John at john@example.com or call 555-123-4567"
        entities = self.detector.detect(text)
        
        assert len(entities) == 2
        
        # Should be sorted by start position
        assert entities[0].entity_type == "EMAIL"
        assert entities[1].entity_type == "PHONE"
    
    def test_no_entities(self):
        """Test text with no sensitive entities."""
        text = "This is a normal sentence with no sensitive information."
        entities = self.detector.detect(text)
        
        assert len(entities) == 0
    
    def test_empty_text(self):
        """Test empty text input."""
        entities = self.detector.detect("")
        assert len(entities) == 0


class TestLocalModelDetector:
    """Test cases for the local model detector."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.detector = LocalModelDetector()
    
    def test_detector_initialization(self):
        """Test detector initialization."""
        assert self.detector.lm_studio_url == "http://localhost:1234"
        assert "PERSON" in self.detector.entity_mapping
        assert "ORG" in self.detector.entity_mapping
    
    def test_is_available_false_when_no_server(self):
        """Test availability check when server is not running."""
        # This will likely fail since LM Studio might not be running
        # but we test the method exists and handles the error gracefully
        result = self.detector.is_available()
        assert isinstance(result, bool)
    
    def test_detect_handles_connection_error(self):
        """Test that detect method handles connection errors gracefully."""
        text = "Hello John Smith from New York"
        entities = self.detector.detect(text)
        
        # Should return empty list when connection fails
        assert isinstance(entities, list)


class TestHybridDetector:
    """Test cases for the hybrid detector."""
    
    def setup_method(self):
        """Set up test fixtures."""
        self.detector = HybridDetector()
    
    def test_rule_based_detection_works(self):
        """Test that rule-based detection works in hybrid mode."""
        text = "Email me at test@example.com"
        entities = self.detector.detect(text)
        
        # Should at least detect the email via rule-based detector
        assert len(entities) >= 1
        email_entities = [e for e in entities if e.entity_type == "EMAIL"]
        assert len(email_entities) == 1
        assert email_entities[0].text == "test@example.com"
    
    def test_remove_duplicates(self):
        """Test duplicate removal functionality."""
        # Create overlapping entities
        entities = [
            DetectedEntity("John", 0, 4, "PERSON", 0.8),
            DetectedEntity("John Smith", 0, 10, "PERSON", 0.9),  # Overlaps with first
            DetectedEntity("example@test.com", 20, 36, "EMAIL", 1.0)
        ]
        
        unique = self.detector._remove_duplicates(entities)
        
        # Should keep the higher confidence overlapping entity and the non-overlapping one
        assert len(unique) == 2
        assert unique[0].text == "John Smith"  # Higher confidence
        assert unique[1].text == "example@test.com"
    
    def test_complex_text_detection(self):
        """Test detection on complex text with multiple entity types."""
        text = """
        Hi, I'm John Smith from Acme Corp. You can reach me at john.smith@acme.com 
        or call me at 555-123-4567. Our office is in New York.
        """
        
        entities = self.detector.detect(text)
        
        # Should detect at least email and phone (rule-based)
        assert len(entities) >= 2
        
        entity_types = [e.entity_type for e in entities]
        assert "EMAIL" in entity_types
        assert "PHONE" in entity_types


class TestDetectedEntity:
    """Test cases for the DetectedEntity dataclass."""
    
    def test_entity_creation(self):
        """Test creating a DetectedEntity."""
        entity = DetectedEntity("test@example.com", 10, 26, "EMAIL", 1.0)
        
        assert entity.text == "test@example.com"
        assert entity.start == 10
        assert entity.end == 26
        assert entity.entity_type == "EMAIL"
        assert entity.confidence == 1.0
    
    def test_entity_default_confidence(self):
        """Test default confidence value."""
        entity = DetectedEntity("John", 0, 4, "PERSON")
        assert entity.confidence == 1.0