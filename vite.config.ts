import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
	root: 'app',
	build: {
		outDir: 'dist',
		emptyOutDir: true
	}
})