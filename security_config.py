"""
Security configuration and hardening utilities for Privacy Guardian Gateway
"""
import os
import secrets
import logging
from datetime import datetime, timedelta
from functools import wraps
from flask import request, jsonify, g
from werkzeug.security import check_password_hash, generate_password_hash

class SecurityConfig:
    """Security configuration and utilities"""
    
    def __init__(self):
        # Security settings
        self.SECRET_KEY = os.getenv('SECRET_KEY', secrets.token_hex(32))
        self.MAX_CONTENT_LENGTH = int(os.getenv('MAX_CONTENT_LENGTH', 16 * 1024 * 1024))  # 16MB
        self.SESSION_TIMEOUT = int(os.getenv('SESSION_TIMEOUT', 3600))  # 1 hour
        self.RATE_LIMIT_PER_MINUTE = int(os.getenv('RATE_LIMIT_PER_MINUTE', 60))
        self.REQUIRE_HTTPS = os.getenv('REQUIRE_HTTPS', 'false').lower() == 'true'
        
        # Initialize rate limiting storage
        self.rate_limit_storage = {}
        
        # Initialize request logging
        self.setup_security_logging()
    
    def setup_security_logging(self):
        """Setup security-focused logging"""
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler('security.log'),
                logging.StreamHandler()
            ]
        )
        self.logger = logging.getLogger('SecurityGuard')
    
    def get_client_ip(self, request):
        """Get real client IP, considering proxies"""
        if request.headers.get('X-Forwarded-For'):
            return request.headers.get('X-Forwarded-For').split(',')[0].strip()
        elif request.headers.get('X-Real-IP'):
            return request.headers.get('X-Real-IP')
        else:
            return request.remote_addr
    
    def rate_limit_check(self, request):
        """Check if request exceeds rate limit"""
        client_ip = self.get_client_ip(request)
        current_time = datetime.now()
        
        # Clean old entries
        cutoff_time = current_time - timedelta(minutes=1)
        self.rate_limit_storage = {
            ip: timestamps for ip, timestamps in self.rate_limit_storage.items()
            if any(ts > cutoff_time for ts in timestamps)
        }
        
        # Update timestamps for current IP
        if client_ip not in self.rate_limit_storage:
            self.rate_limit_storage[client_ip] = []
        
        # Remove old timestamps for this IP
        self.rate_limit_storage[client_ip] = [
            ts for ts in self.rate_limit_storage[client_ip] 
            if ts > cutoff_time
        ]
        
        # Check rate limit
        if len(self.rate_limit_storage[client_ip]) >= self.RATE_LIMIT_PER_MINUTE:
            self.logger.warning(f"Rate limit exceeded for IP: {client_ip}")
            return False
        
        # Add current timestamp
        self.rate_limit_storage[client_ip].append(current_time)
        return True
    
    def validate_request_size(self, request):
        """Validate request size"""
        if request.content_length and request.content_length > self.MAX_CONTENT_LENGTH:
            self.logger.warning(f"Request size too large: {request.content_length} bytes from {self.get_client_ip(request)}")
            return False
        return True
    
    def sanitize_user_input(self, data):
        """Additional input sanitization for security"""
        if isinstance(data, dict):
            sanitized = {}
            for key, value in data.items():
                # Sanitize keys and values
                if isinstance(key, str):
                    key = key.strip()[:1000]  # Limit key length
                if isinstance(value, str):
                    value = value.strip()[:50000]  # Limit value length (generous for AI prompts)
                sanitized[key] = value
            return sanitized
        elif isinstance(data, str):
            return data.strip()[:50000]
        return data
    
    def log_security_event(self, event_type, message, request=None):
        """Log security-related events"""
        client_ip = self.get_client_ip(request) if request else "unknown"
        self.logger.info(f"[{event_type}] {message} - IP: {client_ip}")

# Global security instance
security = SecurityConfig()

def security_middleware(f):
    """Security middleware decorator"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        # HTTPS enforcement (in production)
        if security.REQUIRE_HTTPS and not request.is_secure:
            security.log_security_event("HTTPS_REQUIRED", "Non-HTTPS request blocked", request)
            return jsonify({"error": "HTTPS required"}), 403
        
        # Rate limiting
        if not security.rate_limit_check(request):
            return jsonify({"error": "Rate limit exceeded"}), 429
        
        # Request size validation
        if not security.validate_request_size(request):
            return jsonify({"error": "Request too large"}), 413
        
        # Content-Type validation for POST requests
        if request.method == 'POST':
            if not request.is_json:
                security.log_security_event("INVALID_CONTENT_TYPE", f"Non-JSON POST request", request)
                return jsonify({"error": "Content-Type must be application/json"}), 400
        
        # Log the request
        security.log_security_event("API_REQUEST", f"{request.method} {request.path}", request)
        
        return f(*args, **kwargs)
    
    return decorated_function

def input_validation_middleware(f):
    """Input validation middleware decorator"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if request.method == 'POST' and request.is_json:
            try:
                # Sanitize input data
                original_json = request.get_json()
                sanitized_json = security.sanitize_user_input(original_json)
                
                # Replace request JSON with sanitized version
                request._cached_json = (sanitized_json, True)
                
            except Exception as e:
                security.log_security_event("INPUT_VALIDATION_ERROR", f"Input validation failed: {str(e)}", request)
                return jsonify({"error": "Invalid input data"}), 400
        
        return f(*args, **kwargs)
    
    return decorated_function

def error_handler_secure(error):
    """Secure error handler that doesn't leak sensitive information"""
    error_id = secrets.token_hex(8)
    security.log_security_event("APPLICATION_ERROR", f"Error ID {error_id}: {str(error)}")
    
    # Return generic error in production
    if not os.getenv('FLASK_DEBUG', 'false').lower() == 'true':
        return jsonify({
            "error": "Internal server error",
            "error_id": error_id
        }), 500
    else:
        # In debug mode, return detailed error
        return jsonify({
            "error": str(error),
            "error_id": error_id
        }), 500