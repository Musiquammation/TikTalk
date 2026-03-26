#!/bin/bash

set -e

npm run build

npx cap copy

cd android
./gradlew installDebug

