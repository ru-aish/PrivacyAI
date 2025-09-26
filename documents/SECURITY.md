# Security Hardening Guide for Privacy Guardian Gateway

## Overview

This document outlines the security measures implemented in the Privacy Guardian Gateway to ensure safe deployment and operation in production environments.

## Security Features Implemented

### 1. Input Security
- **Request Size Limits**: Maximum 16MB request size to prevent DoS attacks
- **Input Sanitization**: Automatic sanitization of all user inputs
- **Content-Type Validation**: Enforces JSON content type for API endpoints
- **Rate Limiting**: 60 requests per minute per IP address

### 2. Network Security
- **HTTPS Enforcement**: Optional HTTPS-only mode for production
- **CORS Configuration**: Configurable cross-origin request policies
- **Security Headers**: Automatic security headers (X-Frame-Options, HSTS, etc.)
- **Rate Limiting**: IP-based rate limiting with configurable thresholds

### 3. Application Security
- **Secret Key Management**: Secure secret key generation and management
- **Error Handling**: Secure error responses that don't leak sensitive information
- **Input Validation**: Comprehensive input validation and sanitization
- **Session Security**: Configurable session timeouts

### 4. Logging and Monitoring
- **Security Event Logging**: Comprehensive logging of security events
- **Health Check Endpoints**: Secure health monitoring with token authentication
- **Metrics Collection**: Optional metrics collection for monitoring
- **Request Logging**: Detailed request logging with IP tracking

### 5. Deployment Security
- **Container Security**: Docker configuration with non-root user
- **Process Isolation**: Supervisor-based process management
- **Firewall Configuration**: UFW firewall rules for network protection
- **SSL/TLS Support**: Production-ready SSL/TLS configuration

## Configuration

### Environment Variables

```bash
# Security Settings
SECRET_KEY=your-secret-key-here-generate-a-secure-one
REQUIRE_HTTPS=true
MAX_CONTENT_LENGTH=16777216  # 16MB
SESSION_TIMEOUT=3600  # 1 hour
RATE_LIMIT_PER_MINUTE=60

# Health Check Security
HEALTH_CHECK_TOKEN=your-health-check-token
METRICS_ENABLED=true

# CORS Security
CORS_ORIGINS=https://your-domain.com,https://your-app.com
```

### Security Middleware

All API endpoints are protected with:
- `@security_middleware`: Rate limiting, size validation, HTTPS enforcement
- `@input_validation_middleware`: Input sanitization and validation

### Secure Endpoints

- `/health` - Health check with token authentication
- `/metrics` - Metrics collection with token authentication  
- `/api/*` - All API endpoints with full security middleware

## Deployment Security

### 1. System Security

```bash
# Create dedicated user
sudo useradd --system --shell /bin/bash guardian

# Set proper file permissions
sudo chown -R guardian:guardian /opt/privacy-guardian-gateway
sudo chmod 755 /opt/privacy-guardian-gateway
```

### 2. Network Security

```bash
# Configure firewall
sudo ufw enable
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
```

### 3. Nginx Security

- Security headers automatically added
- Rate limiting at reverse proxy level
- Request size limits
- SSL/TLS termination

### 4. Container Security

```dockerfile
# Non-root user in container
RUN groupadd -r appuser && useradd -r -g appuser appuser
USER appuser

# Health checks
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1
```

## Security Monitoring

### 1. Log Files

- `security.log` - Security events and violations
- `access.log` - HTTP access logs with client IPs
- `error.log` - Application errors
- `supervisor.log` - Process management logs

### 2. Security Events Logged

- Rate limit violations
- Invalid request formats
- HTTPS enforcement violations
- Authentication failures
- Input validation failures
- Application errors

### 3. Monitoring Endpoints

```bash
# Health check
curl "http://localhost:5000/health?token=your-token"

# Metrics
curl "http://localhost:5000/metrics?token=your-token"
```

## Production Checklist

### Pre-Deployment
- [ ] Generate secure SECRET_KEY
- [ ] Configure CORS_ORIGINS for your domain
- [ ] Set REQUIRE_HTTPS=true
- [ ] Configure SSL certificates
- [ ] Set secure HEALTH_CHECK_TOKEN
- [ ] Review rate limiting settings

### Post-Deployment
- [ ] Verify HTTPS is working
- [ ] Test rate limiting
- [ ] Check security headers
- [ ] Verify health checks
- [ ] Monitor security logs
- [ ] Test firewall rules

### Ongoing Security
- [ ] Regular security log review
- [ ] Monitor for unusual request patterns
- [ ] Keep dependencies updated
- [ ] Regular SSL certificate renewal
- [ ] Backup security configurations

## Threat Mitigation

### DoS Protection
- Request size limits
- Rate limiting per IP
- Connection limits in Nginx
- Process isolation with Supervisor

### Data Protection
- Input sanitization
- No sensitive data in logs
- Secure error messages
- Privacy-first design

### Network Security
- HTTPS enforcement
- Security headers
- CORS restrictions
- Firewall protection

### Application Security
- Secure session management
- Input validation
- Error handling
- Process isolation

## Incident Response

### Security Event Response
1. Check `security.log` for event details
2. Identify source IP and request pattern
3. Consider IP blocking if necessary
4. Review application state
5. Document incident

### Log Analysis
```bash
# Recent security events
tail -f /opt/privacy-guardian-gateway/security.log

# Rate limit violations
grep "Rate limit exceeded" /opt/privacy-guardian-gateway/security.log

# Failed requests
grep "ERROR" /opt/privacy-guardian-gateway/security.log
```

## Security Updates

Regular security maintenance:
- Update Python dependencies monthly
- Review security logs weekly
- Update SSL certificates before expiry
- Monitor security advisories
- Test security configurations quarterly

## Contact

For security issues or questions, review the security logs and monitoring endpoints described above.