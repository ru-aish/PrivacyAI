#!/usr/bin/env python3
"""
Privacy Guardian Gateway - Interactive Terminal Interface
Run privacy protection directly from the command line
"""

import os
import sys
import json
from datetime import datetime
from dotenv import load_dotenv

# Add the current directory to Python path so we can import our modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from privacy_guardian.sanitizer.processor import PrivacyProcessor
from privacy_guardian.ai_client import AIServiceManager
from privacy_guardian.multi_ai_coordinator import MultiAICoordinator

# Load environment variables
load_dotenv()

class PrivacyTerminal:
    def __init__(self):
        """Initialize the privacy terminal interface"""
        self.privacy_processor = PrivacyProcessor()
        self.ai_manager = AIServiceManager()
        self.multi_ai_coordinator = MultiAICoordinator()
        self.session_history = []
        
        # Colors for terminal output
        self.COLORS = {
            'red': '\033[91m',
            'green': '\033[92m',
            'yellow': '\033[93m',
            'blue': '\033[94m',
            'purple': '\033[95m',
            'cyan': '\033[96m',
            'white': '\033[97m',
            'bold': '\033[1m',
            'underline': '\033[4m',
            'end': '\033[0m'
        }
        
        # Settings
        self.show_ai_response = True
        self.current_ai_service = self.ai_manager.default_service
        self.system_prompt = None
        self.use_multi_ai_coordination = True  # Default to new coordination system
        
    def colored_text(self, text, color):
        """Apply color to text"""
        return f"{self.COLORS.get(color, '')}{text}{self.COLORS['end']}"
    
    def print_header(self):
        """Print the application header"""
        header = """
╔══════════════════════════════════════════════════════════════════╗
║                    🛡️  PRIVACY GUARDIAN GATEWAY                   ║
║                     Interactive Terminal Interface                ║
╚══════════════════════════════════════════════════════════════════╝
        """
        print(self.colored_text(header, 'cyan'))
        print(self.colored_text("🔒 Your privacy is protected - PII is automatically detected and secured", 'green'))
        print()
    
    def print_help(self):
        """Print help information"""
        help_text = f"""
 📖 COMMANDS:
  /help              - Show this help message
  /settings          - Show current settings and service status
  /ai <service>      - Switch AI service (gemini, lm_studio, auto)
  /system            - Set system prompt for AI
  /toggle-ai         - Toggle AI response simulation
  /toggle-coord      - Toggle multi-AI coordination ({self.colored_text('ON' if self.use_multi_ai_coordination else 'OFF', 'green' if self.use_multi_ai_coordination else 'red')})
  /history           - Show session history
  /clear             - Clear session history
  /test              - Run multi-level privacy test examples
   /demo              - Interactive demo with your own message
   /coord-test        - Test multi-AI coordination system
   /filter-test       - Interactive filter testing (shows all levels)
   /prompt-analysis   - Detailed prompt analysis with timing
                        Usage: /prompt-analysis [--json] [message]
                        Examples:
                          /prompt-analysis
                          /prompt-analysis my name is john
                          /prompt-analysis --json test message
   /quit or /exit     - Exit the application

 💬 USAGE MODES:
  🚀 Multi-AI Coordination (Default): Intelligent service routing
    • Analyzes request type and complexity
    • Routes privacy analysis to LM Studio
    • Routes main AI tasks to optimal service
    • Provides detailed coordination info

  🔒 Legacy Multi-Level: Traditional privacy protection
    • Level 1: Basic rule-based detection
    • Main Level: AI-powered privacy analysis
    • Context Level: Intelligent context analysis
    • Shows what each service would receive

🎯 EXAMPLES:
  > Write a Python function to calculate fibonacci
  > My name is John and my email is john@example.com, help me
  > Tell me a creative story about a robot
  > Explain how machine learning works
        """
        print(self.colored_text(help_text, 'yellow'))
    
    def print_settings(self):
        """Print current settings"""
        # Test AI connections
        gemini_status = self.ai_manager.test_connection('gemini')
        lm_studio_status = self.ai_manager.test_connection('lm_studio')
        
        # Get coordination status
        coordination_status = self.multi_ai_coordinator.get_service_status()
        
        mode = "Multi-AI Coordination" if self.use_multi_ai_coordination else "Legacy Multi-Level"
        
        settings_text = f"""
⚙️  CURRENT SETTINGS:
  Processing Mode: {self.colored_text(mode, 'cyan')}
  AI Service: {self.colored_text(self.current_ai_service, 'green')}
  AI Response: {self.colored_text('ON' if self.show_ai_response else 'OFF', 'green' if self.show_ai_response else 'red')}
  System Prompt: {self.colored_text(self.system_prompt[:50] + '...' if self.system_prompt and len(self.system_prompt) > 50 else self.system_prompt or 'None', 'blue')}

🚀 MULTI-AI COORDINATION STATUS:
  Privacy Analyzer: {self.colored_text(coordination_status['privacy_analyzer']['status'].upper(), 'green' if coordination_status['privacy_analyzer']['status'] == 'available' else 'red')}
  Coordination Metrics: {len(coordination_status['coordination_metrics'])} services tracked

📡 AI SERVICE STATUS:
  Gemini: {self.colored_text('✅ Connected' if gemini_status['status'] == 'success' else '❌ ' + gemini_status.get('error', 'Error'), 'green' if gemini_status['status'] == 'success' else 'red')}
  LM Studio: {self.colored_text('✅ Connected' if lm_studio_status['status'] == 'success' else '❌ ' + lm_studio_status.get('error', 'Error'), 'green' if lm_studio_status['status'] == 'success' else 'red')}

📊 SERVICE CAPABILITIES (Multi-AI Mode):
  LM Studio - Privacy: {coordination_status['service_capabilities']['lm_studio']['privacy_analysis']:.2f}, Code: {coordination_status['service_capabilities']['lm_studio']['code_generation']:.2f}
  Gemini - Creative: {coordination_status['service_capabilities']['gemini']['creative_writing']:.2f}, Reasoning: {coordination_status['service_capabilities']['gemini']['reasoning']:.2f}
        """
        print(settings_text)
    
    def print_history(self):
        """Print session history"""
        if not self.session_history:
            print(self.colored_text("📝 No messages in history", 'yellow'))
            return
        
        print(self.colored_text(f"📝 SESSION HISTORY ({len(self.session_history)} messages):", 'cyan'))
        print("-" * 60)
        
        for i, entry in enumerate(self.session_history[-10:], 1):  # Show last 10
            timestamp = entry['timestamp'].strftime('%H:%M:%S')
            print(f"{self.colored_text(f'[{timestamp}]', 'blue')} {entry['original'][:50]}{'...' if len(entry['original']) > 50 else ''}")
        
        if len(self.session_history) > 10:
            print(f"... and {len(self.session_history) - 10} more entries")
        print()
    
    def run_test_example(self):
        """Run a test example to demonstrate the multi-level system"""
        test_cases = [
            "so my name is rudra",
            "My friend dharm works at Google in Mumbai", 
            "Hi, I'm Dr. Sarah Johnson from New York and my email is sarah.johnson@hospital.com"
        ]
        
        print(self.colored_text("🧪 RUNNING MULTI-LEVEL PRIVACY TEST EXAMPLES:", 'purple'))
        print(self.colored_text("=" * 60, 'purple'))
        
        for i, test_message in enumerate(test_cases, 1):
            print(self.colored_text(f"\n📋 TEST CASE {i}:", 'purple'))
            print(f"Input: {self.colored_text(test_message, 'white')}")
            print()
            
            self.process_message(test_message, is_test=True)
            
            if i < len(test_cases):
                input(self.colored_text("Press Enter to continue to next test case...", 'yellow'))
    
    def process_message(self, message, is_test=False):
        """Process a user message through the multi-AI coordinated privacy system"""
        try:
            if self.use_multi_ai_coordination:
                self._process_with_multi_ai_coordination(message, is_test)
            else:
                self._process_with_legacy_system(message, is_test)
                
        except Exception as e:
            print(self.colored_text(f"❌ Error processing message: {str(e)}", 'red'))
            print(self.colored_text("💡 Try /help for available commands", 'yellow'))
    
    def _process_with_multi_ai_coordination(self, message, is_test=False):
        """Process message using new multi-AI coordination system"""
        print(self.colored_text("🚀 MULTI-AI COORDINATION SYSTEM ACTIVATED", 'cyan'))
        print(self.colored_text("=" * 60, 'cyan'))
        print()
        
        # Show original message
        print(self.colored_text("📝 ORIGINAL USER INPUT:", 'blue'))
        print(f"   {self.colored_text(message, 'white')}")
        print()
        
        # Step 1: Multi-AI Analysis
        print(self.colored_text("🧠 STEP 1: MULTI-AI REQUEST ANALYSIS", 'green'))
        context = self.multi_ai_coordinator.analyze_request_type(message, self.system_prompt)
        selected_service = self.multi_ai_coordinator.select_optimal_service(context)
        service_scores = self.multi_ai_coordinator._calculate_current_scores(context)
        
        print(self.colored_text(f"   📊 Request Type: {context.request_type.value}", 'green'))
        print(self.colored_text(f"   🔒 Privacy Sensitive: {context.privacy_sensitive}", 'green'))
        print(self.colored_text(f"   🎯 Complexity: {context.estimated_complexity:.2f}", 'green'))
        print(self.colored_text(f"   🤖 Selected Service: {selected_service.upper()}", 'green'))
        print()
        
        print(self.colored_text("   📈 Service Capability Scores:", 'green'))
        for service, score in service_scores.items():
            color = 'cyan' if service == selected_service else 'white'
            indicator = "👑" if service == selected_service else "  "
            print(f"   {indicator} {service.upper()}: {self.colored_text(f'{score:.2f}', color)}")
        print()
        
        # Step 2: Privacy Protection (always LM Studio)
        print(self.colored_text("🛡️  STEP 2: AI-POWERED PRIVACY PROTECTION", 'purple'))
        print(self.colored_text("   Using LM Studio for intelligent privacy analysis...", 'purple'))
        
        coordination_result = self.multi_ai_coordinator.process_with_coordination(
            message, 
            system_prompt=self.system_prompt,
            preferred_service=self.current_ai_service if self.current_ai_service != 'auto' else None
        )
        
        privacy_info = coordination_result['privacy_protection']
        
        if privacy_info['detections']:
            print(self.colored_text("   🎯 Privacy Items Detected & Anonymized:", 'purple'))
            for detection in privacy_info['detections']:
                print(f"   • {detection['type']}: {self.colored_text(detection['original'], 'white')} → {self.colored_text(detection['replacement'], 'cyan')}")
                print(f"     Confidence: {detection['confidence']:.2f}")
            
            print()
            print(self.colored_text("   🛡️  ANONYMIZED VERSION:", 'purple'))
            print(f"   \"{self.colored_text(privacy_info['anonymized_text'], 'purple')}\"")
        else:
            print(self.colored_text("   ✅ No privacy concerns detected", 'purple'))
        print()
        
        # Step 3: Multi-Service Processing
        print(self.colored_text("⚙️  STEP 3: MULTI-SERVICE AI PROCESSING", 'yellow'))
        ai_info = coordination_result['ai_response']
        coord_info = coordination_result['coordination_info']
        
        print(self.colored_text(f"   🎯 Privacy Analysis Service: {coord_info['privacy_service'].upper()}", 'yellow'))
        print(self.colored_text(f"   🤖 Main AI Service: {coord_info['main_ai_service'].upper()}", 'yellow'))
        print(self.colored_text(f"   ⏱️  Total Processing Time: {coord_info['processing_time']:.2f}s", 'yellow'))
        print()
        
        # Show what each service would receive/provide
        print(self.colored_text("📤 SERVICE INTERACTION DETAILS:", 'blue'))
        print(self.colored_text(f"   🔒 LM Studio (Privacy): Analyzed original text for PII", 'blue'))
        print(self.colored_text(f"   🤖 {coord_info['main_ai_service'].upper()} (Main AI): Received anonymized text", 'blue'))
        print(f"   📥 Input: \"{self.colored_text(privacy_info['anonymized_text'], 'white')}\"")
        print(f"   📤 Output: \"{self.colored_text(ai_info['sanitized_response'][:100], 'white')}...\"")
        print()
        
        # Step 4: Response Restoration
        print(self.colored_text("🔄 STEP 4: PRIVACY RESTORATION", 'cyan'))
        if privacy_info['session_map']:
            print(self.colored_text("   📋 Restoring personal information in response:", 'cyan'))
            for replacement, original in privacy_info['session_map'].items():
                print(f"   • {self.colored_text(replacement, 'yellow')} → {self.colored_text(original, 'white')}")
            print()
        
        print(self.colored_text("✅ FINAL RESPONSE:", 'green'))
        print(self.colored_text("=" * 20, 'green'))
        print(f"{self.colored_text(ai_info['final_response'], 'white')}")
        print()
        
        # Show coordination summary
        self._show_coordination_summary(coordination_result)
    
    def _process_with_legacy_system(self, message, is_test=False):
        """Process message using legacy multi-level system (for comparison)"""
        print(self.colored_text("🔒 LEGACY MULTI-LEVEL PRIVACY PROTECTION", 'cyan'))
        print(self.colored_text("=" * 60, 'cyan'))
        print()
        
        # Show original message
        print(self.colored_text("📝 ORIGINAL USER INPUT:", 'blue'))
        print(f"   {self.colored_text(message, 'white')}")
        print()
        
        # LEVEL 1: Basic Rule-Based Detection (show what traditional system would do)
        print(self.colored_text("🔍 LEVEL 1: BASIC RULE-BASED DETECTION", 'yellow'))
        traditional_processor = PrivacyProcessor(use_ai_analyzer=False)
        level1_result = traditional_processor.sanitize(message)
        
        if level1_result.entities:
            print(self.colored_text("   Basic patterns detected:", 'yellow'))
            for entity in level1_result.entities:
                print(f"   • {entity.entity_type}: {self.colored_text(entity.text, 'white')}")
            print(f"   Traditional result: {self.colored_text(level1_result.sanitized_text, 'yellow')}")
            if 'rudra' in level1_result.sanitized_text or 'dharm' in level1_result.sanitized_text:
                print(self.colored_text("   ⚠️  Basic detection has privacy leakage!", 'red'))
        else:
            print(self.colored_text("   No basic patterns detected", 'yellow'))
        print()
        
        # MAIN LEVEL: AI-Powered Privacy Analysis
        print(self.colored_text("🧠 MAIN LEVEL: AI-POWERED PRIVACY ANALYSIS", 'green'))
        print(self.colored_text("   Using AI to analyze for ANY personal information...", 'green'))
        
        # Get the AI analysis details
        from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
        ai_analyzer = AIPrivacyAnalyzer()
        ai_result = ai_analyzer.analyze_and_anonymize(message)
        
        if ai_result['detections']:
            print(self.colored_text("   🎯 AI Privacy Analysis Results:", 'green'))
            for detection in ai_result['detections']:
                print(f"   • {detection.privacy_type}: {self.colored_text(detection.original_text, 'white')} → {self.colored_text(detection.replacement_text, 'cyan')}")
                print(f"     Confidence: {detection.confidence:.2f} | Reason: {detection.reasoning}")
            
            print()
            print(self.colored_text("   🛡️  AI-ANONYMIZED RESULT:", 'green'))
            print(f"   {self.colored_text(ai_result['anonymized_text'], 'green')}")
        else:
            print(self.colored_text("   ✅ AI found no privacy concerns", 'green'))
        print()
        
        # Show what would be sent to different AI services
        print(self.colored_text("📤 PRIVACY-PROTECTED PROMPTS FOR AI SERVICES:", 'purple'))
        
        final_prompt = ai_result['anonymized_text'] if ai_result['detections'] else message
        
        # Show prompts for different services
        print(self.colored_text("   🤖 GEMINI API would receive:", 'purple'))
        print(f"   \"{self.colored_text(final_prompt, 'white')}\"")
        print()
        
        print(self.colored_text("   🏠 LM STUDIO would receive:", 'purple'))  
        print(f"   \"{self.colored_text(final_prompt, 'white')}\"")
        print()
        
        print(self.colored_text("   🔒 OPENAI would receive:", 'purple'))
        print(f"   \"{self.colored_text(final_prompt, 'white')}\"")
        print()
        
        # Context-Aware Level (show when context might be needed)
        print(self.colored_text("🎯 CONTEXT-AWARE LEVEL: INTELLIGENT CONTEXT ANALYSIS", 'cyan'))
        
        # Simple context analysis
        context_needed = self._analyze_context_need(message, ai_result['detections'])
        if context_needed:
            print(self.colored_text("   📋 AI determined this query needs personal context:", 'cyan'))
            print(f"   Reason: {context_needed}")
            print()
            print(self.colored_text("   📤 CONTEXT-ENHANCED PROMPT would be:", 'cyan'))
            context_prompt = self._create_context_enhanced_prompt(final_prompt, ai_result['detections'])
            print(f"   \"{self.colored_text(context_prompt, 'white')}\"")
        else:
            print(self.colored_text("   ✅ No personal context needed for this query", 'cyan'))
        print()
        
        # Show session mapping for restoration
        if ai_result['detections']:
            print(self.colored_text("🔄 SESSION MAPPING (for response restoration):", 'blue'))
            for detection in ai_result['detections']:
                print(f"   {self.colored_text(detection.replacement_text, 'cyan')} ↔ {self.colored_text(detection.original_text, 'white')}")
            print()
        
        # AI Processing (if enabled) - but don't actually send
        if self.show_ai_response:
            print(self.colored_text("🚫 AI RESPONSE SIMULATION (not actually sent):", 'yellow'))
            print(self.colored_text("   [This is where the AI response would appear after privacy restoration]", 'yellow'))
            print(self.colored_text("   💡 Use /toggle-ai to disable this simulation", 'yellow'))
        else:
            print(self.colored_text("ℹ️  AI PROCESSING DISABLED", 'blue'))
            print(self.colored_text("   Use /toggle-ai to enable AI response simulation", 'blue'))
        
        # Add to history
        if not is_test:
            self.session_history.append({
                'timestamp': datetime.now(),
                'original': message,
                'sanitized': final_prompt,
                'privacy_items': [d.original_text for d in ai_result['detections']]
            })
            
        print(self.colored_text("=" * 80, 'cyan'))
        print()
    
    def _analyze_context_need(self, original_message, detections):
        """Analyze if the query needs personal context"""
        # Simple heuristic - check if the query is ABOUT the personal information
        message_lower = original_message.lower()
        
        for detection in detections:
            name_lower = detection.original_text.lower()
            
            # Check for queries about the name/info itself
            if any(phrase in message_lower for phrase in [
                f"about {name_lower}",
                f"is {name_lower}",
                f"what is {name_lower}",
                f"who is {name_lower}",
                f"tell me about {name_lower}",
                f"meaning of {name_lower}",
                f"origin of {name_lower}"
            ]):
                return f"Query appears to be about the personal information '{detection.original_text}' itself"
        
        return None
    
    def _create_context_enhanced_prompt(self, anonymized_prompt, detections):
        """Create a context-enhanced prompt when personal context is needed"""
        if not detections:
            return anonymized_prompt
        
        context_block = "\n{--- CONTEXT ---}\n"
        for detection in detections:
            context_block += f"• {detection.replacement_text} refers to: {detection.original_text}\n"
        context_block += "{--- END CONTEXT ---}\n"
        
        return anonymized_prompt + context_block
    
    def handle_command(self, command):
        """Handle special commands"""
        parts = command[1:].split(' ', 1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else None
        
        if cmd in ['help', 'h']:
            self.print_help()
        
        elif cmd == 'settings':
            self.print_settings()
        
        elif cmd == 'ai':
            if arg and arg.lower() in ['gemini', 'lm_studio', 'auto']:
                old_service = self.current_ai_service
                self.current_ai_service = arg.lower()
                print(self.colored_text(f"🔄 AI service changed from {old_service} to {self.current_ai_service}", 'green'))
                if arg.lower() == 'auto':
                    print(self.colored_text("🤖 Auto mode: Service will be selected based on request type", 'blue'))
            else:
                print(self.colored_text("❌ Usage: /ai <gemini|lm_studio|auto>", 'red'))
        
        elif cmd == 'system':
            if arg:
                self.system_prompt = arg
                print(self.colored_text(f"📝 System prompt set: {arg[:50]}{'...' if len(arg) > 50 else ''}", 'green'))
            else:
                self.system_prompt = None
                print(self.colored_text("🗑️  System prompt cleared", 'green'))
        
        elif cmd == 'toggle-ai':
            self.show_ai_response = not self.show_ai_response
            status = "enabled" if self.show_ai_response else "disabled"
            print(self.colored_text(f"🔄 AI responses {status}", 'green'))
        
        elif cmd == 'toggle-coord':
            self.use_multi_ai_coordination = not self.use_multi_ai_coordination
            mode = "Multi-AI Coordination" if self.use_multi_ai_coordination else "Legacy Multi-Level"
            print(self.colored_text(f"🔄 Switched to {mode} mode", 'green'))
            if self.use_multi_ai_coordination:
                print(self.colored_text("🚀 Now using intelligent service routing and coordination", 'blue'))
            else:
                print(self.colored_text("🔒 Now using traditional multi-level privacy protection", 'blue'))
        
        elif cmd == 'history':
            self.print_history()
        
        elif cmd == 'clear':
            self.session_history.clear()
            print(self.colored_text("🗑️  Session history cleared", 'green'))
        
        elif cmd == 'test':
            self.run_test_example()
        
        elif cmd == 'demo':
            mode = "Multi-AI Coordination" if self.use_multi_ai_coordination else "Legacy Multi-Level"
            print(self.colored_text(f"🎬 PRIVACY PROTECTION DEMO - {mode} mode", 'purple'))
            demo_message = input(self.colored_text("Enter a message to analyze: ", 'cyan'))
            if demo_message:
                self.process_message(demo_message, is_test=True)
        
        elif cmd == 'coord-test':
            self._run_coordination_test()
        
        elif cmd == 'filter-test':
            self._run_interactive_filter_test()
        
        elif cmd == 'prompt-analysis':
            if arg:
                if arg.startswith('--json '):
                    message = arg[7:].strip()
                    self._run_prompt_analysis(single_message=message, json_output=True)
                else:
                    self._run_prompt_analysis(single_message=arg)
            else:
                self._run_prompt_analysis()
        
        elif cmd in ['quit', 'exit', 'q']:
            print(self.colored_text("👋 Thank you for using Privacy Guardian Gateway!", 'cyan'))
            return False
        
        else:
            print(self.colored_text(f"❌ Unknown command: {command}", 'red'))
            print(self.colored_text("💡 Type /help for available commands", 'yellow'))
        
        return True
    
    def run(self):
        """Main terminal loop"""
        self.print_header()
        
        # Show initial settings
        self.print_settings()
        
        print(self.colored_text("💬 Type your message below (or /help for commands):", 'cyan'))
        print(self.colored_text("🚀 Ready to protect your privacy!", 'green'))
        print()
        
        try:
            while True:
                # Get user input
                try:
                    user_input = input(self.colored_text("Privacy Guardian> ", 'bold')).strip()
                except KeyboardInterrupt:
                    print(self.colored_text("\n👋 Goodbye!", 'cyan'))
                    break
                
                if not user_input:
                    continue
                
                # Handle commands
                if user_input.startswith('/'):
                    if not self.handle_command(user_input):
                        break
                else:
                    # Process regular message
                    self.process_message(user_input)
        
        except Exception as e:
            print(self.colored_text(f"❌ Unexpected error: {str(e)}", 'red'))
        
        print(self.colored_text("🛡️  Privacy Guardian Gateway terminated safely", 'green'))
    
    def _run_coordination_test(self):
        """Run multi-AI coordination test with various request types"""
        print(self.colored_text("🚀 MULTI-AI COORDINATION TEST", 'cyan'))
        print(self.colored_text("=" * 50, 'cyan'))
        print()
        
        test_prompts = [
            ("Write a Python function to sort a list", "code_generation"),
            ("Tell me a story about a magical forest", "creative_writing"),
            ("My name is Alice, help me write a resume", "privacy_sensitive"),
            ("Explain how neural networks work", "technical_analysis"),
            ("What's 2+2?", "general_chat"),
            ("Solve this logic puzzle: A is taller than B...", "reasoning")
        ]
        
        for i, (prompt, expected_type) in enumerate(test_prompts, 1):
            print(self.colored_text(f"🧪 TEST {i}: {expected_type.upper()}", 'blue'))
            print(f"   Prompt: \"{self.colored_text(prompt, 'white')}\"")
            
            # Analyze without full processing
            context = self.multi_ai_coordinator.analyze_request_type(prompt)
            selected_service = self.multi_ai_coordinator.select_optimal_service(context)
            scores = self.multi_ai_coordinator._calculate_current_scores(context)
            
            print(f"   Detected Type: {self.colored_text(context.request_type.value, 'green')}")
            print(f"   Privacy Sensitive: {self.colored_text(str(context.privacy_sensitive), 'yellow' if context.privacy_sensitive else 'green')}")
            print(f"   Selected Service: {self.colored_text(selected_service.upper(), 'cyan')}")
            print(f"   Scores: LM Studio={scores.get('lm_studio', 0):.2f}, Gemini={scores.get('gemini', 0):.2f}")
            
            # Check if our selection makes sense
            if expected_type in context.request_type.value or context.request_type.value in expected_type:
                print(self.colored_text("   ✅ Correct type detection", 'green'))
            else:
                print(self.colored_text("   ⚠️  Type detection mismatch", 'yellow'))
            
            print()
            
            if i < len(test_prompts):
                input(self.colored_text("Press Enter for next test...", 'blue'))
        
        # Show coordination status
        print(self.colored_text("📊 COORDINATION SYSTEM STATUS:", 'purple'))
        status = self.multi_ai_coordinator.get_service_status()
        
        print(f"   Privacy Analyzer: {self.colored_text(status['privacy_analyzer']['status'], 'green' if status['privacy_analyzer']['status'] == 'available' else 'red')}")
        
        for service, info in status['ai_services'].items():
            status_color = 'green' if info['status'] == 'success' else 'red'
            print(f"   {service.upper()}: {self.colored_text(info['status'], status_color)}")
        
        print()
        print(self.colored_text("✅ Coordination test completed!", 'green'))
    
    def _show_coordination_summary(self, coordination_result):
        """Show detailed coordination summary"""
        print(self.colored_text("📊 COORDINATION SUMMARY:", 'blue'))
        print(self.colored_text("-" * 25, 'blue'))
        
        coord_info = coordination_result['coordination_info']
        request_info = coordination_result['request_analysis']
        
        print(f"   Request Type: {self.colored_text(request_info['type'].title(), 'white')}")
        print(f"   Privacy Sensitive: {self.colored_text(str(request_info['privacy_sensitive']), 'white')}")
        print(f"   Complexity Score: {self.colored_text(f'{request_info['complexity']:.2f}', 'white')}")
        print(f"   Processing Time: {self.colored_text(f'{coord_info['processing_time']:.2f}s', 'white')}")
        print()
        
        # Show service scores that influenced the decision
        print(self.colored_text("   🎯 Service Selection Scores:", 'blue'))
        for service, score in coord_info['service_scores'].items():
            indicator = "👑" if service == request_info['selected_service'] else "  "
            print(f"   {indicator} {service.upper()}: {score:.2f}")
        print()

    def _run_interactive_filter_test(self):
        """Interactive testing mode showing all filter levels with timing"""
        print(self.colored_text("🧪 INTERACTIVE FILTER TESTING MODE", 'cyan'))
        print(self.colored_text("=" * 60, 'cyan'))
        print(self.colored_text("This mode shows prompts at different filter levels WITHOUT sending to AI", 'blue'))
        print()
        
        while True:
            try:
                # Get user input
                user_message = input(self.colored_text("🔬 Enter test message (or 'quit' to exit): ", 'cyan')).strip()
                
                if user_message.lower() in ['quit', 'exit', 'q', '']:
                    print(self.colored_text("🔬 Filter testing completed!", 'green'))
                    break
                
                print(self.colored_text("\n" + "=" * 80, 'purple'))
                print(self.colored_text("🧪 COMPREHENSIVE FILTER ANALYSIS", 'purple'))
                print(self.colored_text("=" * 80, 'purple'))
                
                self._analyze_all_filter_levels(user_message)
                
                print(self.colored_text("\n" + "=" * 80, 'purple'))
                print()
                
            except KeyboardInterrupt:
                print(self.colored_text("\n🔬 Filter testing interrupted!", 'yellow'))
                break
            except Exception as e:
                print(self.colored_text(f"❌ Error during testing: {str(e)}", 'red'))

    def _run_prompt_analysis(self, single_message=None, json_output=False):
        """Detailed prompt analysis with comprehensive timing
        
        Args:
            single_message: If provided, analyze just this message and exit
            json_output: If True, output in JSON format for AI consumption
        """
        if single_message:
            if json_output:
                result = self._detailed_prompt_analysis(single_message, json_output=True)
                print(json.dumps(result, indent=2))
            else:
                print(self.colored_text("📊 DETAILED PROMPT ANALYSIS MODE", 'cyan'))
                print(self.colored_text("=" * 60, 'cyan'))
                print()
                print(self.colored_text("=" * 80, 'green'))
                print(self.colored_text("📊 DETAILED PROMPT ANALYSIS WITH TIMING", 'green'))
                print(self.colored_text("=" * 80, 'green'))
                self._detailed_prompt_analysis(single_message)
                print(self.colored_text("\n" + "=" * 80, 'green'))
            return
        
        print(self.colored_text("📊 DETAILED PROMPT ANALYSIS MODE", 'cyan'))
        print(self.colored_text("=" * 60, 'cyan'))
        print(self.colored_text("Provides comprehensive timing and analysis data", 'blue'))
        print(self.colored_text("💡 Tip: Use --json flag for machine-readable output", 'yellow'))
        print()
        
        while True:
            try:
                user_message = input(self.colored_text("📊 Enter message for analysis (or 'quit' to exit): ", 'cyan')).strip()
                
                if user_message.lower() in ['quit', 'exit', 'q', '']:
                    print(self.colored_text("📊 Prompt analysis completed!", 'green'))
                    break
                
                print(self.colored_text("\n" + "=" * 80, 'green'))
                print(self.colored_text("📊 DETAILED PROMPT ANALYSIS WITH TIMING", 'green'))
                print(self.colored_text("=" * 80, 'green'))
                
                self._detailed_prompt_analysis(user_message)
                
                print(self.colored_text("\n" + "=" * 80, 'green'))
                print()
                
            except KeyboardInterrupt:
                print(self.colored_text("\n📊 Analysis interrupted!", 'yellow'))
                break
            except Exception as e:
                print(self.colored_text(f"❌ Error during analysis: {str(e)}", 'red'))

    def _analyze_all_filter_levels(self, message):
        """Analyze message through all filter levels with timing"""
        import time
        from privacy_guardian.sanitizer.processor import PrivacyProcessor
        from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
        
        total_start = time.time()
        
        # Display original message
        print(self.colored_text("📝 ORIGINAL INPUT:", 'white'))
        print(f"   {self.colored_text(message, 'white')}")
        print(f"   Length: {len(message)} characters")
        print()
        
        # LEVEL 1: Basic Rule-Based Detection
        print(self.colored_text("🔍 FILTER LEVEL 1: BASIC RULE-BASED DETECTION", 'yellow'))
        level1_start = time.time()
        
        basic_processor = PrivacyProcessor(use_ai_analyzer=False)
        level1_result = basic_processor.sanitize(message)
        
        level1_time = time.time() - level1_start
        
        print(f"   ⏱️  Processing Time: {level1_time:.3f}s")
        if level1_result.entities:
            print(self.colored_text("   📋 Basic Patterns Detected:", 'yellow'))
            for entity in level1_result.entities:
                print(f"   • {entity.entity_type}: {self.colored_text(entity.text, 'white')}")
            print(f"   📤 Level 1 Output: {self.colored_text(level1_result.sanitized_text, 'yellow')}")
        else:
            print(self.colored_text("   ✅ No basic patterns detected", 'yellow'))
            print(f"   📤 Level 1 Output: {self.colored_text(message, 'yellow')}")
        print()
        
        # LEVEL 2: AI-Powered Privacy Analysis
        print(self.colored_text("🧠 FILTER LEVEL 2: AI-POWERED PRIVACY ANALYSIS", 'green'))
        level2_start = time.time()
        
        ai_analyzer = AIPrivacyAnalyzer()
        ai_result = ai_analyzer.analyze_and_anonymize(message)
        
        level2_time = time.time() - level2_start
        
        print(f"   ⏱️  Processing Time: {level2_time:.3f}s")
        if ai_result['detections']:
            print(self.colored_text("   🎯 AI Privacy Detections:", 'green'))
            for detection in ai_result['detections']:
                print(f"   • {detection.privacy_type}: {self.colored_text(detection.original_text, 'white')} → {self.colored_text(detection.replacement_text, 'cyan')}")
                print(f"     Confidence: {detection.confidence:.2f} | Reason: {detection.reasoning}")
            print(f"   📤 Level 2 Output: {self.colored_text(ai_result['anonymized_text'], 'green')}")
        else:
            print(self.colored_text("   ✅ AI found no privacy concerns", 'green'))
            print(f"   📤 Level 2 Output: {self.colored_text(message, 'green')}")
        print()
        
        # LEVEL 3: Multi-AI Coordination Analysis
        print(self.colored_text("🚀 FILTER LEVEL 3: MULTI-AI COORDINATION", 'blue'))
        level3_start = time.time()
        
        context = self.multi_ai_coordinator.analyze_request_type(message)
        selected_service = self.multi_ai_coordinator.select_optimal_service(context)
        service_scores = self.multi_ai_coordinator._calculate_current_scores(context)
        
        level3_time = time.time() - level3_start
        
        print(f"   ⏱️  Processing Time: {level3_time:.3f}s")
        print(f"   📊 Request Type: {self.colored_text(context.request_type.value, 'blue')}")
        print(f"   🔒 Privacy Sensitive: {self.colored_text(str(context.privacy_sensitive), 'blue')}")
        print(f"   🎯 Complexity: {self.colored_text(f'{context.estimated_complexity:.2f}', 'blue')}")
        print(f"   🤖 Selected Service: {self.colored_text(selected_service.upper(), 'blue')}")
        
        print(self.colored_text("   📈 Service Scores:", 'blue'))
        for service, score in service_scores.items():
            indicator = "👑" if service == selected_service else "  "
            print(f"   {indicator} {service.upper()}: {score:.2f}")
        
        # Final prompt that would be sent
        final_prompt = ai_result['anonymized_text'] if ai_result['detections'] else message
        print(f"   📤 Level 3 Final Prompt: {self.colored_text(final_prompt, 'blue')}")
        print()
        
        # SUMMARY
        total_time = time.time() - total_start
        print(self.colored_text("📊 PROCESSING SUMMARY:", 'purple'))
        print(f"   🕐 Level 1 (Basic): {level1_time:.3f}s")
        print(f"   🕑 Level 2 (AI Privacy): {level2_time:.3f}s")
        print(f"   🕒 Level 3 (Coordination): {level3_time:.3f}s")
        print(f"   🕓 Total Processing: {total_time:.3f}s")
        print()
        print(self.colored_text("📤 FINAL PROMPT (What would be sent to AI):", 'purple'))
        print(f"   Service: {self.colored_text(selected_service.upper(), 'white')}")
        print(f"   Prompt: \"{self.colored_text(final_prompt, 'white')}\"")
        print(self.colored_text("   ⚠️  NOTE: This prompt is NOT actually sent to any AI service", 'red'))

    def _detailed_prompt_analysis(self, message, json_output=False):
        """Provide detailed analysis with comprehensive metrics
        
        Args:
            message: The message to analyze
            json_output: If True, return structured data instead of printing
        """
        import time
        from datetime import datetime
        from privacy_guardian.sanitizer.processor import PrivacyProcessor
        from privacy_guardian.sanitizer.ai_privacy_analyzer import AIPrivacyAnalyzer
        
        analysis_start = time.time()
        
        metadata = {
            'timestamp': datetime.now().isoformat(),
            'input_length': len(message),
            'word_count': len(message.split()),
            'character_analysis': self._analyze_character_types(message) if not json_output else self._get_character_types_dict(message)
        }
        
        if not json_output:
            print(self.colored_text("📋 ANALYSIS METADATA:", 'cyan'))
            print(f"   🕐 Timestamp: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            print(f"   📏 Input Length: {len(message)} characters")
            print(f"   📝 Word Count: {len(message.split())}")
            print(f"   🔤 Character Types: {metadata['character_analysis']}")
            print()
        
        level1_start = time.time()
        basic_processor = PrivacyProcessor(use_ai_analyzer=False)
        level1_result = basic_processor.sanitize(message)
        level1_time = time.time() - level1_start
        
        level2_start = time.time()
        ai_analyzer = AIPrivacyAnalyzer()
        ai_result = ai_analyzer.analyze_and_anonymize(message)
        level2_time = time.time() - level2_start
        
        level3_start = time.time()
        context = self.multi_ai_coordinator.analyze_request_type(message)
        selected_service = self.multi_ai_coordinator.select_optimal_service(context)
        service_scores = self.multi_ai_coordinator._calculate_current_scores(context)
        level3_time = time.time() - level3_start
        
        total_time = time.time() - analysis_start
        
        if json_output:
            return {
                'metadata': metadata,
                'original_message': message,
                'level1_basic_filter': {
                    'processing_time_seconds': level1_time,
                    'entities_detected': [
                        {
                            'type': entity.entity_type,
                            'text': entity.text,
                            'start': entity.start,
                            'end': entity.end
                        } for entity in level1_result.entities
                    ],
                    'sanitized_text': level1_result.sanitized_text
                },
                'level2_ai_privacy': {
                    'processing_time_seconds': level2_time,
                    'detections': [
                        {
                            'privacy_type': d.privacy_type,
                            'original_text': d.original_text,
                            'replacement_text': d.replacement_text,
                            'confidence': d.confidence,
                            'reasoning': d.reasoning
                        } for d in ai_result['detections']
                    ],
                    'anonymized_text': ai_result['anonymized_text']
                },
                'level3_multi_ai_coordination': {
                    'processing_time_seconds': level3_time,
                    'request_type': context.request_type.value,
                    'privacy_sensitive': context.privacy_sensitive,
                    'estimated_complexity': context.estimated_complexity,
                    'selected_service': selected_service,
                    'service_scores': service_scores
                },
                'final_output': {
                    'selected_service': selected_service,
                    'final_prompt': ai_result['anonymized_text'] if ai_result['detections'] else message,
                    'privacy_protected': bool(ai_result['detections'])
                },
                'timing_summary': {
                    'level1_seconds': level1_time,
                    'level2_seconds': level2_time,
                    'level3_seconds': level3_time,
                    'total_seconds': total_time,
                    'processing_speed_chars_per_second': len(message) / total_time if total_time > 0 else 0
                }
            }
        else:
            self._analyze_all_filter_levels(message)
            
            analysis_time = time.time() - analysis_start
            print(self.colored_text("🔬 ANALYSIS METRICS:", 'cyan'))
            print(f"   ⏱️  Total Analysis Time: {analysis_time:.3f}s")
            print(f"   🚀 Processing Speed: {len(message)/analysis_time:.1f} chars/second")
            print(f"   💾 Memory Impact: Minimal (stateless processing)")

    def _analyze_character_types(self, text):
        """Analyze character composition of input text"""
        letters = sum(c.isalpha() for c in text)
        digits = sum(c.isdigit() for c in text)
        spaces = sum(c.isspace() for c in text)
        special = len(text) - letters - digits - spaces
        
        return f"Letters: {letters}, Digits: {digits}, Spaces: {spaces}, Special: {special}"
    
    def _get_character_types_dict(self, text):
        """Get character composition as dictionary"""
        letters = sum(c.isalpha() for c in text)
        digits = sum(c.isdigit() for c in text)
        spaces = sum(c.isspace() for c in text)
        special = len(text) - letters - digits - spaces
        
        return {
            'letters': letters,
            'digits': digits,
            'spaces': spaces,
            'special': special
        }

def main():
    """Main entry point"""
    try:
        terminal = PrivacyTerminal()
        terminal.run()
    except Exception as e:
        print(f"❌ Failed to start Privacy Guardian Terminal: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()