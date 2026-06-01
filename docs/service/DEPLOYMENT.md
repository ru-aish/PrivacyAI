# Privacy Guardian Gateway - Production Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying the Privacy Guardian Gateway in a production environment with full security hardening.

## Prerequisites

- Ubuntu 20.04 LTS or newer
- Python 3.11+
- At least 2GB RAM
- 10GB free disk space
- Domain name (for SSL/HTTPS)

## Quick Deployment

### 1. Automated Deployment

```bash
# Clone the repository
git clone <your-repo-url>
cd privacy-guardian-gateway

# Run full deployment (requires sudo)
./deploy.sh full
```

### 2. Manual Deployment Steps

#### Step 1: System Dependencies
```bash
./deploy.sh deps
```

#### Step 2: Application Setup
```bash
./deploy.sh app
```

#### Step 3: Configure Services
```bash
./deploy.sh services
```

#### Step 4: Security Configuration
```bash
./deploy.sh security
```

## Configuration

### 1. Environment Setup

```bash
# Copy production environment template
cp .env.production .env

# Edit configuration
nano .env
```

### 2. Required Environment Variables

```bash
# Security (REQUIRED)
SECRET_KEY=generate-a-secure-32-character-key-here
HEALTH_CHECK_TOKEN=generate-a-secure-token-here

# AI Services (at least one required)
GEMINI_API_KEY=your-gemini-api-key
LM_STUDIO_BASE_URL=http://localhost:1234/v1

# Production Settings
FLASK_ENV=production
FLASK_DEBUG=false
REQUIRE_HTTPS=true
CORS_ORIGINS=https://yourdomain.com
```

## SSL/HTTPS Setup

### Option 1: Let's Encrypt (Recommended)

```bash
# Install Certbot
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

### Option 2: Custom SSL Certificate

```bash
# Place your certificates
sudo cp your-cert.pem /etc/ssl/certs/privacy-guardian.pem
sudo cp your-key.pem /etc/ssl/private/privacy-guardian.key

# Update Nginx configuration
sudo nano /etc/nginx/sites-available/privacy-guardian-gateway
```

## Docker Deployment

### 1. Build Container

```bash
# Build the image
docker build -t privacy-guardian-gateway .

# Create data directory
mkdir -p ./data/logs
```

### 2. Run Container

```bash
# Run with environment file
docker run -d \
  --name privacy-guardian \
  -p 5000:5000 \
  -v ./data/logs:/app/logs \
  --env-file .env \
  --restart unless-stopped \
  privacy-guardian-gateway
```

### 3. Docker Compose

```yaml
version: '3.8'
services:
  privacy-guardian:
    build: .
    ports:
      - "5000:5000"
    volumes:
      - ./data/logs:/app/logs
    env_file:
      - .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Monitoring and Maintenance

### 1. Service Status

```bash
# Check application status
sudo supervisorctl status privacy-guardian-gateway

# Check Nginx status
sudo systemctl status nginx

# Check logs
sudo tail -f /opt/privacy-guardian-gateway/logs/supervisor.log
```

### 2. Health Monitoring

```bash
# Health check
curl "https://yourdomain.com/health?token=your-health-token"

# Metrics
curl "https://yourdomain.com/metrics?token=your-health-token"

# Service status
curl "https://yourdomain.com/api/status"
```

### 3. Log Monitoring

```bash
# Security events
sudo tail -f /opt/privacy-guardian-gateway/security.log

# Access logs
sudo tail -f /var/log/nginx/access.log

# Error logs
sudo tail -f /var/log/nginx/error.log
```

## Performance Tuning

### 1. Gunicorn Configuration

Edit `gunicorn.conf.py`:

```python
# Adjust workers based on your server
workers = (CPU_CORES * 2) + 1

# Adjust timeout for AI response times
timeout = 60

# Memory management
max_requests = 1000
max_requests_jitter = 100
```

### 2. Nginx Optimization

```nginx
# Add to nginx configuration
client_max_body_size 16M;
proxy_connect_timeout 60s;
proxy_send_timeout 60s;
proxy_read_timeout 60s;

# Enable gzip compression
gzip on;
gzip_types application/json text/css text/javascript;
```

## Security Best Practices

### 1. Regular Updates

```bash
# Update system packages
sudo apt update && sudo apt upgrade

# Update Python dependencies
pip install --upgrade -r requirements.txt

# Restart services
sudo supervisorctl restart privacy-guardian-gateway
```

### 2. Security Monitoring

```bash
# Weekly security log review
grep "ERROR\|WARNING" /opt/privacy-guardian-gateway/security.log

# Check for unusual patterns
grep "Rate limit exceeded" /opt/privacy-guardian-gateway/security.log

# Monitor failed requests
grep "403\|404\|500" /var/log/nginx/access.log
```

### 3. Backup Strategy

```bash
# Backup configuration
tar -czf privacy-guardian-backup-$(date +%Y%m%d).tar.gz \
  /opt/privacy-guardian-gateway/.env \
  /etc/nginx/sites-available/privacy-guardian-gateway \
  /etc/supervisor/conf.d/privacy-guardian-gateway.conf

# Backup logs (optional)
tar -czf logs-backup-$(date +%Y%m%d).tar.gz \
  /opt/privacy-guardian-gateway/logs/
```

## Troubleshooting

### Common Issues

#### 1. Service Won't Start

```bash
# Check logs
sudo supervisorctl tail privacy-guardian-gateway

# Check configuration
sudo supervisorctl reread
sudo supervisorctl update
```

#### 2. SSL Certificate Issues

```bash
# Check certificate status
sudo certbot certificates

# Renew certificate
sudo certbot renew --dry-run
```

#### 3. Rate Limiting Issues

```bash
# Check rate limit logs
grep "Rate limit exceeded" /opt/privacy-guardian-gateway/security.log

# Adjust rate limits in .env
RATE_LIMIT_PER_MINUTE=120
```

#### 4. Memory Issues

```bash
# Check memory usage
free -h
ps aux | grep gunicorn

# Reduce Gunicorn workers if needed
# Edit gunicorn.conf.py
workers = 2
```

## Performance Benchmarks

Expected performance with proper configuration:

- **Response Time**: 3-7 seconds (depending on AI service)
- **Throughput**: 60 requests/minute per IP (configurable)
- **Memory Usage**: 200-500MB per worker
- **CPU Usage**: Low (except during AI processing)

## Support

### Log Locations

- Application: `/opt/privacy-guardian-gateway/logs/`
- Nginx: `/var/log/nginx/`
- System: `/var/log/syslog`

### Key Commands

```bash
# Restart application
sudo supervisorctl restart privacy-guardian-gateway

# Reload Nginx
sudo nginx -t && sudo systemctl reload nginx

# Check all services
sudo systemctl status nginx supervisor
```

## Security Compliance

This deployment includes:

- ✅ HTTPS encryption
- ✅ Rate limiting
- ✅ Input validation
- ✅ Security headers
- ✅ Process isolation
- ✅ Firewall protection
- ✅ Secure error handling
- ✅ Audit logging
- ✅ Health monitoring

## Production Checklist

Before going live:

- [ ] SSL certificate installed and working
- [ ] All environment variables configured
- [ ] Firewall rules tested
- [ ] Health checks responding
- [ ] Log rotation configured
- [ ] Backup strategy implemented
- [ ] Monitoring alerts set up
- [ ] Security review completed
- [ ] Performance testing done
- [ ] Documentation reviewed