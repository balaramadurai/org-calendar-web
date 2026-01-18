#!/bin/bash
# Setup Android SDK command-line tools for building the app
# Works on Arch Linux / Manjaro

set -e

ANDROID_HOME="$HOME/Android/Sdk"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

echo "=== Android SDK Setup ==="
echo ""

# Check if already installed
if [ -d "$ANDROID_HOME/cmdline-tools" ]; then
    echo "Android SDK already installed at $ANDROID_HOME"
    echo "To reinstall, remove that directory first."
    exit 0
fi

# Install Java if needed
if ! command -v java &> /dev/null; then
    echo "Installing Java (OpenJDK 17)..."
    sudo pacman -S --noconfirm jdk17-openjdk
fi

# Install required packages
echo "Installing required packages..."
sudo pacman -S --noconfirm --needed unzip wget

# Create SDK directory
echo "Creating SDK directory at $ANDROID_HOME..."
mkdir -p "$ANDROID_HOME/cmdline-tools"

# Download command-line tools
echo "Downloading Android command-line tools..."
cd /tmp
wget -q --show-progress "$CMDLINE_TOOLS_URL" -O cmdline-tools.zip

# Extract
echo "Extracting..."
unzip -q cmdline-tools.zip
mv cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
rm cmdline-tools.zip

# Add to PATH
echo ""
echo "Adding to shell config..."

# Fish shell config
FISH_CONFIG="$HOME/.config/fish/config.fish"
if [ -f "$FISH_CONFIG" ] || [ "$SHELL" = "/usr/bin/fish" ]; then
    mkdir -p "$HOME/.config/fish"
    if ! grep -q "ANDROID_HOME" "$FISH_CONFIG" 2>/dev/null; then
        cat >> "$FISH_CONFIG" << 'EOF'

# Android SDK
set -gx ANDROID_HOME $HOME/Android/Sdk
fish_add_path $ANDROID_HOME/cmdline-tools/latest/bin
fish_add_path $ANDROID_HOME/platform-tools
EOF
        echo "Added ANDROID_HOME to $FISH_CONFIG"
    fi
fi

# Also add to bash/zsh for scripts that use them
SHELL_RC="$HOME/.bashrc"
[ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"

if ! grep -q "ANDROID_HOME" "$SHELL_RC" 2>/dev/null; then
    cat >> "$SHELL_RC" << 'EOF'

# Android SDK
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"
EOF
    echo "Added ANDROID_HOME to $SHELL_RC"
fi

# Export for current session
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin"

# Accept licenses and install required components
echo ""
echo "Installing SDK components (this may take a few minutes)..."
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null 2>&1 || true
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
    "platform-tools" \
    "platforms;android-34" \
    "build-tools;34.0.0"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Run this to apply PATH changes:"
if [ "$SHELL" = "/usr/bin/fish" ] || [ -f "$HOME/.config/fish/config.fish" ]; then
    echo "  source ~/.config/fish/config.fish"
else
    echo "  source $SHELL_RC"
fi
echo ""
echo "Then build the app with:"
echo "  cd $(dirname "$0")"
echo "  ./gradlew assembleDebug"
echo ""
