const highImpactSshCommandPattern = /\b(rm\s+-rf|mkfs(?:\.\w+)?|dd\s+if=|wipefs|fdisk|parted|shutdown|reboot|halt|poweroff|init\s+0|systemctl\s+(?:restart|stop|disable)|service\s+\S+\s+(?:restart|stop)|docker\s+(?:rm|rmi|system\s+prune)|kubectl\s+delete|helm\s+uninstall|apt(?:-get)?\s+(?:install|remove|purge|upgrade|dist-upgrade)|yum\s+(?:install|remove|update)|dnf\s+(?:install|remove|upgrade)|apk\s+(?:add|del|upgrade)|pacman\s+-S|chown\s+-R|chmod\s+-R)\b/i;

export function getSshCommandConfirmationReason(command: string) {
  const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return highImpactSshCommandPattern.test(normalized) ? 'high-impact SSH command' : '';
}
