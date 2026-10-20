#!/bin/sh
# Собирает docs/index.html для GitHub Pages из site/index.html:
# исходник — только содержимое страницы, здесь добавляются doctype и <head>.
set -eu
cd "$(dirname "$0")/.."
{
  printf '<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  cat site/index.html
  printf '\n</html>\n'
} > docs/index.html
echo docs/index.html
