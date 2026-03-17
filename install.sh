#!/bin/sh
sudo apt update
if [ "${INSTALL_DENO:-0}" = "1" ]; then
	chmod +x denoinstall.sh
	./denoinstall.sh
else
	echo "Skipping optional Deno installation (set INSTALL_DENO=1 to enable)."
fi
npm install
echo "Installation successfully run, you can now run 'npm start' to start bot"
