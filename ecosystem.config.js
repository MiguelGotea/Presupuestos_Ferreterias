// ecosystem.config.js — Presupuestos Ferreterías (PM2)
module.exports = {
  apps: [
    {
      name: "presupuestos-ferreterias",
      script: "server.js",
      cwd: "/root/presupuestos-ferreterias",
      interpreter: "node",
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      env: {
        PORT: "3002",
        NODE_ENV: "production"
      },
      error_file: "/root/presupuestos-ferreterias/logs/error.log",
      out_file:   "/root/presupuestos-ferreterias/logs/output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
}
