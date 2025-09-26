"""
Flask web application for Privacy Guardian Gateway
Provides web interface and API for privacy-aware AI interactions
"""
import os
import json
import logging
from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
from privacy_guardian.sanitizer.processor import PrivacyProcessor
from privacy_guardian.ai_client import AIServiceManager
from privacy_guardian.multi_ai_coordinator import MultiAICoordinator
from security_config import security, security_middleware, input_validation_middleware, error_handler_secure

# Load environment variables
load_dotenv()

app = Flask(__name__, 
           template_folder='templates',
           static_folder='static')

# Configure Flask with security settings
app.config['SECRET_KEY'] = security.SECRET_KEY
app.config['MAX_CONTENT_LENGTH'] = security.MAX_CONTENT_LENGTH
app.config['DEBUG'] = os.getenv('FLASK_DEBUG', 'false').lower() == 'true'
app.config['TESTING'] = False

# Configure CORS for production
cors_origins = os.getenv('CORS_ORIGINS', '*').split(',')
CORS(app, origins=cors_origins, supports_credentials=True)

# Register error handlers
app.register_error_handler(500, error_handler_secure)
app.register_error_handler(Exception, error_handler_secure)

# Initialize services
privacy_processor = PrivacyProcessor()
ai_manager = AIServiceManager()
multi_ai_coordinator = MultiAICoordinator()  # New multi-AI coordination system

@app.route('/')
def index():
    """Serve the main web interface"""
    return render_template('index.html')

@app.route('/api/process', methods=['POST'])
@security_middleware
@input_validation_middleware
def process_request():
    """
    Main API endpoint for processing user requests with multi-AI coordination
    
    Expected JSON payload:
    {
        "message": "user message with potential PII",
        "ai_service": "gemini" or "lm_studio" (optional),
        "system_prompt": "optional system prompt for AI",
        "use_coordination": true/false (default: true)
    }
    
    Returns:
    {
        "status": "success" or "error",
        "request_analysis": {...},
        "privacy_protection": {...},
        "ai_response": {...},
        "coordination_info": {...}
    }
    """
    try:
        # Parse request
        data = request.get_json()
        if not data or 'message' not in data:
            return jsonify({
                "status": "error",
                "error": "Missing 'message' field in request"
            }), 400
        
        user_message = data['message']
        ai_service = data.get('ai_service')  # Optional service selection
        system_prompt = data.get('system_prompt')  # Optional system prompt
        use_coordination = data.get('use_coordination', True)  # Default to coordination
        
        if use_coordination:
            # Use advanced multi-AI coordination
            result = multi_ai_coordinator.process_with_coordination(
                user_message,
                system_prompt=system_prompt,
                preferred_service=ai_service
            )
            
            return jsonify({
                "status": "success",
                "request_analysis": result['request_analysis'],
                "privacy_protection": result['privacy_protection'],
                "ai_response": result['ai_response'],
                "coordination_info": result['coordination_info'],
                "multi_ai_enabled": True
            })
        
        else:
            # Legacy single-service processing
            sanitized_result = privacy_processor.sanitize(user_message)
            sanitized_message = sanitized_result.sanitized_text
            privacy_items = list(sanitized_result.session_map.keys())
            
            ai_response = ai_manager.generate_response(
                sanitized_message, 
                system_prompt=system_prompt,
                service=ai_service
            )
            
            final_response = privacy_processor.desanitize(
                ai_response, 
                sanitized_result.session_map
            )
            
            return jsonify({
                "status": "success",
                "sanitized_message": sanitized_message,
                "ai_response": ai_response,
                "final_response": final_response,
                "privacy_items_detected": privacy_items,
                "ai_service_used": ai_service or ai_manager.default_service,
                "multi_ai_enabled": False
            })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e)
        }), 500

@app.route('/api/test-connection', methods=['POST'])
@security_middleware
@input_validation_middleware
def test_ai_connection():
    """
    Test connection to AI services
    
    Expected JSON payload:
    {
        "service": "gemini" or "lm_studio"
    }
    """
    try:
        data = request.get_json()
        service = data.get('service', ai_manager.default_service)
        
        result = ai_manager.test_connection(service)
        
        return jsonify(result)
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "service": service,
            "error": str(e)
        }), 500

@app.route('/api/coordination-demo', methods=['POST'])
@security_middleware
@input_validation_middleware
def coordination_demo():
    """
    Demonstrate multi-AI coordination with detailed analysis
    
    Expected JSON payload:
    {
        "prompts": ["prompt1", "prompt2", ...] or "prompt": "single prompt"
    }
    """
    try:
        data = request.get_json()
        
        # Handle both single prompt and multiple prompts
        if 'prompt' in data:
            prompts = [data['prompt']]
        elif 'prompts' in data:
            prompts = data['prompts']
        else:
            return jsonify({
                "status": "error",
                "error": "Missing 'prompt' or 'prompts' field in request"
            }), 400
        
        demo_results = []
        
        for prompt in prompts:
            # Analyze request type
            context = multi_ai_coordinator.analyze_request_type(prompt)
            
            # Get service selection reasoning
            selected_service = multi_ai_coordinator.select_optimal_service(context)
            service_scores = multi_ai_coordinator._calculate_current_scores(context)
            
            demo_results.append({
                "prompt": prompt,
                "analysis": {
                    "request_type": context.request_type.value,
                    "privacy_sensitive": context.privacy_sensitive,
                    "estimated_complexity": context.estimated_complexity
                },
                "service_selection": {
                    "selected_service": selected_service,
                    "service_scores": service_scores,
                    "selection_reasoning": f"Selected {selected_service} for {context.request_type.value} (score: {service_scores.get(selected_service, 0):.2f})"
                }
            })
        
        # Get overall coordination status
        coordination_status = multi_ai_coordinator.get_service_status()
        
        return jsonify({
            "status": "success",
            "demo_results": demo_results,
            "coordination_overview": {
                "privacy_analyzer_status": coordination_status['privacy_analyzer']['status'],
                "available_services": [
                    service for service, info in coordination_status['ai_services'].items()
                    if info['status'] == 'success'
                ],
                "service_capabilities": coordination_status['service_capabilities']
            }
        })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e)
        }), 500

@app.route('/api/sanitize', methods=['POST'])
@security_middleware
@input_validation_middleware
def sanitize_only():
    """
    API endpoint for sanitization only (no AI interaction)
    
    Expected JSON payload:
    {
        "message": "user message with potential PII"
    }
    """
    try:
        data = request.get_json()
        if not data or 'message' not in data:
            return jsonify({
                "status": "error",
                "error": "Missing 'message' field in request"
            }), 400
        
        user_message = data['message']
        
        # Sanitize the message
        sanitized_result = privacy_processor.sanitize(user_message)
        
        return jsonify({
            "status": "success",
            "original_message": user_message,
            "sanitized_message": sanitized_result.sanitized_text,
            "privacy_items_detected": list(sanitized_result.session_map.keys()),
            "replacements": sanitized_result.session_map
        })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e)
        }), 500

@app.route('/api/status')
@security_middleware
def get_status():
    """Get comprehensive service status including multi-AI coordination"""
    try:
        # Get multi-AI coordinator status
        coordination_status = multi_ai_coordinator.get_service_status()
        
        # Legacy service status for backwards compatibility
        gemini_status = ai_manager.test_connection('gemini')
        lm_studio_status = ai_manager.test_connection('lm_studio')
        
        return jsonify({
            "status": "running",
            "multi_ai_coordination": {
                "enabled": True,
                "privacy_analyzer": coordination_status['privacy_analyzer'],
                "service_capabilities": coordination_status['service_capabilities'],
                "coordination_metrics": coordination_status['coordination_metrics']
            },
            "legacy_services": {
                "default_ai_service": ai_manager.default_service,
                "gemini": gemini_status,
                "lm_studio": lm_studio_status
            },
            "privacy_processor": "operational"
        })
        
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e)
        }), 500

@app.route('/health')
def health_check():
    """Health check endpoint for monitoring systems"""
    health_token = request.args.get('token')
    expected_token = os.getenv('HEALTH_CHECK_TOKEN')
    
    if expected_token and health_token != expected_token:
        return jsonify({"error": "Unauthorized"}), 401
    
    try:
        # Quick health checks
        privacy_test = privacy_processor.sanitize("test@example.com").sanitized_text
        ai_available = any([
            ai_manager.test_connection('gemini')['status'] == 'success',
            ai_manager.test_connection('lm_studio')['status'] == 'success'
        ])
        
        return jsonify({
            "status": "healthy",
            "timestamp": security.logger.handlers[0].stream.name if security.logger.handlers else "N/A",
            "privacy_engine": "operational" if "PLACEHOLDER_EMAIL" in privacy_test else "error",
            "ai_services": "available" if ai_available else "unavailable"
        })
        
    except Exception as e:
        return jsonify({
            "status": "unhealthy",
            "error": str(e)
        }), 503

@app.route('/metrics')
def metrics():
    """Basic metrics endpoint for monitoring"""
    metrics_token = request.args.get('token')
    expected_token = os.getenv('HEALTH_CHECK_TOKEN')
    
    if expected_token and metrics_token != expected_token:
        return jsonify({"error": "Unauthorized"}), 401
    
    if not os.getenv('METRICS_ENABLED', 'false').lower() == 'true':
        return jsonify({"error": "Metrics disabled"}), 404
    
    # Basic metrics (can be extended with proper metrics library)
    return jsonify({
        "active_connections": len(security.rate_limit_storage),
        "rate_limit_storage_size": sum(len(timestamps) for timestamps in security.rate_limit_storage.values()),
        "privacy_processor_status": "operational"
    })

if __name__ == "__main__":
    port = int(os.getenv('FLASK_PORT', 5000))
    app.run(
        host='0.0.0.0',
        port=port,
        debug=app.config['DEBUG']
    )