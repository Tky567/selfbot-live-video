#!bin/sh
sudo apt update
chmod +x denoinstall.sh
./denoinstall.sh
npm install
echo "Installation successfully run, you can now run 'npm start' to start bot"
