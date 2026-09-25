#!/bin/bash
# 部署采集 agent 到 N100（常驻 systemd 服务）
# 用法：./deploy.sh [ssh 别名，默认 n100]
set -e
HOST="${1:-n100}"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "==> 目标: $HOST"
ssh -o ConnectTimeout=8 "$HOST" 'sudo mkdir -p /opt/n100-agent'
scp -o ConnectTimeout=8 "$SRC/n100_agent.py" "$HOST":/tmp/n100_agent.py
scp -o ConnectTimeout=8 "$SRC/n100-agent.service" "$HOST":/tmp/n100-agent.service
ssh -o ConnectTimeout=8 "$HOST" '
  sudo mv /tmp/n100_agent.py /opt/n100-agent/n100_agent.py
  sudo chmod +x /opt/n100-agent/n100_agent.py
  sudo mv /tmp/n100-agent.service /etc/systemd/system/n100-agent.service
  sudo systemctl daemon-reload
  sudo systemctl enable n100-agent
  sudo systemctl restart n100-agent
  sleep 3
  sudo systemctl is-active n100-agent
'
echo "==> 服务已启动，验证接口："
ssh -o ConnectTimeout=8 "$HOST" 'curl -s --compressed http://100.111.73.34:9100/api/health'
echo
echo "完成。本机验证: curl -s --compressed http://100.111.73.34:9100/api/snapshot | head -c 400"
