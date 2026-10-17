import { createApp } from 'vue';

/**
 * 字体自托管（只引 latin 子集，避免把整包字重与其它字符集带进产物）。
 *
 * 为什么是 IBM Plex 这一对：等宽在这套设计里是主角（标题、数据、日志都是它），
 * 而 Plex 的蒙与无衬线出自同一套设计，笔画与字重节奏对得上——两个不相干的
 * 家族混用，标题和正文会像来自两个产品。中文不打包（几 MB，手机流量不值当），
 * 交给系统 Noto Sans SC / PingFang，见 tokens.css 的 --font-* 回退链。
 *
 * 字重只用三档：400 正文、500 标题与强调、600 仅用于产品记号。再多就是浪费带宽。
 */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';

import './styles/tokens.css';
import './styles/base.css';

import App from './App.vue';
import { router } from './router.ts';

createApp(App).use(router).mount('#app');
