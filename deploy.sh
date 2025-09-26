#!/bin/bash

# Privacy Guardian Gateway Deployment Script
# This script helps deploy the application in various environments

set -e

# Configuration
APP_NAME="privacy-guardian-gateway"
APP_DIR="/opt/${APP_NAME}"
SERVICE_USER="guardian"
PYTHON_VERSION="3.11"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
    exit 1
}

# Check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        error "This script should not be run as root for security reasons"
    fi
}

# Install system dependencies
install_dependencies() {
    log "Installing system dependencies..."
    
    # Update package list
    sudo apt-get update
    
    # Install required packages
    sudo apt-get install -y \
        python${PYTHON_VERSION} \
        python${PYTHON_VERSION}-pip \
        python${PYTHON_VERSION}-venv \
        nginx \
        supervisor \
        curl \
        git \
        ufw
    
    log "System dependencies installed successfully"
}

# Setup application user
setup_user() {
    log "Setting up application user..."
    
    if ! id "$SERVICE_USER" &>/dev/null; then
        sudo useradd --system --shell /bin/bash --home $APP_DIR $SERVICE_USER
        log "Created user: $SERVICE_USER"
    else
        log "User $SERVICE_USER already exists"
    fi
}

# Setup application directory
setup_directory() {
    log "Setting up application directory..."
    
    sudo mkdir -p $APP_DIR
    sudo chown $SERVICE_USER:$SERVICE_USER $APP_DIR
    
    log "Application directory created: $APP_DIR"
}

# Deploy application
deploy_app() {
    log "Deploying application..."
    
    # Copy application files
    sudo cp -r . $APP_DIR/
    sudo chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR
    
    # Setup Python virtual environment
    sudo -u $SERVICE_USER python${PYTHON_VERSION} -m venv $APP_DIR/venv
    sudo -u $SERVICE_USER $APP_DIR/venv/bin/pip install --upgrade pip
    sudo -u $SERVICE_USER $APP_DIR/venv/bin/pip install -r $APP_DIR/requirements.txt
    
    log "Application deployed successfully"
}

# Configure firewall
configure_firewall() {
    log "Configuring firewall..."
    
    # Enable UFW
    sudo ufw --force enable
    
    # Allow SSH (important!)
    sudo ufw allow ssh
    
    # Allow HTTP and HTTPS
    sudo ufw allow 80
    sudo ufw allow 443
    
    # Allow application port (if different)
    sudo ufw allow 5000
    
    log "Firewall configured"
}

# Setup Nginx reverse proxy
setup_nginx() {
    log "Setting up Nginx reverse proxy..."
    
    cat > /tmp/privacy-guardian-nginx.conf << 'EOF'
server {
    listen 80;
    server_name _;
    
    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
    
    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api:10m rate=60r/m;
    
    location / {
        limit_req zone=api burst=20 nodelay;
        
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    
    # Health check endpoint
    location /health {
        access_log off;
        proxy_pass http://127.0.0.1:5000/health;
    }
}
EOF
    
    sudo mv /tmp/privacy-guardian-nginx.conf /etc/nginx/sites-available/$APP_NAME
    sudo ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/
    sudo rm -f /etc/nginx/sites-enabled/default
    
    # Test nginx configuration
    sudo nginx -t
    sudo systemctl reload nginx
    
    log "Nginx configured successfully"
}

# Setup Supervisor for process management
setup_supervisor() {
    log "Setting up Supervisor..."
    
    cat > /tmp/privacy-guardian-supervisor.conf << EOF
[program:privacy-guardian-gateway]
command=$APP_DIR/venv/bin/gunicorn --config $APP_DIR/gunicorn.conf.py app:app
directory=$APP_DIR
user=$SERVICE_USER
autostart=true
autorestart=true
redirect_stderr=true
stdout_logfile=$APP_DIR/logs/supervisor.log
environment=PATH="$APP_DIR/venv/bin"
EOF
    
    sudo mv /tmp/privacy-guardian-supervisor.conf /etc/supervisor/conf.d/$APP_NAME.conf
    sudo supervisorctl reread
    sudo supervisorctl update
    
    log "Supervisor configured successfully"
}

# Setup log rotation
setup_logrotate() {
    log "Setting up log rotation..."
    
    cat > /tmp/privacy-guardian-logrotate << EOF
$APP_DIR/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 $SERVICE_USER $SERVICE_USER
    postrotate
        supervisorctl restart privacy-guardian-gateway
    endscript
}
EOF
    
    sudo mv /tmp/privacy-guardian-logrotate /etc/logrotate.d/$APP_NAME
    
    log "Log rotation configured"
}

# Main deployment function
main() {
    log "Starting Privacy Guardian Gateway deployment..."
    
    case "${1:-full}" in
        "deps")
            install_dependencies
            ;;
        "app")
            setup_user
            setup_directory
            deploy_app
            ;;
        "services")
            setup_nginx
            setup_supervisor
            setup_logrotate
            ;;
        "security")
            configure_firewall
            ;;
        "full")
            check_root
            install_dependencies
            setup_user
            setup_directory
            deploy_app
            configure_firewall
            setup_nginx
            setup_supervisor
            setup_logrotate
            ;;
        *)
            error "Usage: $0 {deps|app|services|security|full}"
            ;;
    esac
    
    log "Deployment completed successfully!"
    log "Application should be available at: http://$(hostname -I | awk '{print $1}')"
    log "Check status with: sudo supervisorctl status privacy-guardian-gateway"
}

# Run main function
main "$@"