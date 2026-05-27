/**
 * PM2 Ecosystem File — FusionWorkspace production process manager
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload ecosystem.config.cjs
 *   pm2 logs fusion-workspace
 */

module.exports = {
  apps: [
    {
      name: 'fusion-workspace',
      script: './dist/start.js',
      args: '--config config/runtime.production.template.json',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      // Graceful shutdown
      kill_timeout: 15000,
      wait_ready: true,
      listen_timeout: 10000,

      // Auto-restart on crash (with backoff)
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '512M',

      // Logging
      error_file: './logs/fusion-error.log',
      out_file: './logs/fusion-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Health monitoring
      exp_backoff_restart_delay: 1000,
      min_uptime: 10000,
    },
  ],
}
