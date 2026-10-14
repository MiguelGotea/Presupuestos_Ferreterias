# Auto-navegar a la raíz del proyecto (un nivel arriba de .scripts)
Set-Location (Split-Path $PSScriptRoot -Parent)

# Script de despliegue — Presupuestos Ferreterias
Write-Host "Iniciando envio para Presupuestos Ferreterias..." -ForegroundColor Cyan

# 1. Preparar commits
git add .
$msg = "Ferreterias Update $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
git commit -m "$msg" 2>$null

# 2. Sincronizacion Segura
Write-Host "Sincronizando con GitHub..." -ForegroundColor Gray
git pull origin main --rebase

if ($LASTEXITCODE -ne 0) {
    Write-Host "Conflicto detectado. Reparando..." -ForegroundColor Yellow
    git rebase --abort 2>$null
    git pull origin main --no-rebase -X ours
    git add .
    git commit -m "$msg (Conflict Resolve)" 2>$null
}

# 3. Push final (dispara el GitHub Action automaticamente)
git push origin main
Write-Host "Proyecto en GitHub. El Deploy automatico comenzara ahora." -ForegroundColor Green
