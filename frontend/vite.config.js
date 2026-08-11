import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // For GitHub project pages, set base to '/YOUR_REPO_NAME/'.
  // For a custom domain or username.github.io root site, leave '/'.
  base: '/',
});
