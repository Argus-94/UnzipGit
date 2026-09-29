package com.unzipgit.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.ActionBarDrawerToggle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.GravityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.drawerlayout.widget.DrawerLayout
import com.google.android.material.navigation.NavigationView
import com.unzipgit.app.databinding.ActivityMainBinding
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

class MainActivity : AppCompatActivity(), NavigationView.OnNavigationItemSelectedListener {

    private lateinit var binding: ActivityMainBinding
    private companion object {
        const val ASSETS = "https://appassets.androidplatform.net/assets/"
        // При запуске открывается страница со списком репозиториев
        const val HOME_URL = ASSETS + "repos.html"
        const val UNZIP_URL = ASSETS + "index.html"
        const val FILES_URL = ASSETS + "files.html"
        const val TOKENS_URL = ASSETS + "tokens.html"
    }

    @Volatile
    private var operationRunning = false
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val httpExecutor = Executors.newCachedThreadPool()

    // Файл, ожидающий сохранения после выбора места в системном окне
    @Volatile
    private var pendingSave: ByteArray? = null

    private val saveLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("*/*")
    ) { uri: Uri? ->
        val bytes = pendingSave
        pendingSave = null
        if (uri != null && bytes != null) {
            httpExecutor.execute {
                val ok = try {
                    contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } != null
                } catch (e: Exception) {
                    false
                }
                runOnUiThread {
                    Toast.makeText(
                        this@MainActivity,
                        getString(if (ok) R.string.file_saved else R.string.file_save_error),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        val uris = if (result.resultCode == RESULT_OK && data != null) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
        } else {
            null
        }
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setSupportActionBar(binding.toolbar)

        val toggle = ActionBarDrawerToggle(
            this, binding.drawerLayout, binding.toolbar,
            R.string.navigation_drawer_open, R.string.navigation_drawer_close
        )
        binding.drawerLayout.addDrawerListener(toggle)
        toggle.syncState()

        binding.navView.setNavigationItemSelectedListener(this)
        setupDrawerHeaderInsets()
        binding.drawerLayout.addDrawerListener(object : DrawerLayout.SimpleDrawerListener() {
            override fun onDrawerStateChanged(newState: Int) {
                if (newState != DrawerLayout.STATE_IDLE) {
                    applyDrawerHeaderInset()
                    updateHeaderRepo()
                }
            }
        })

        // Нижняя панель: возвращаем false — выделение ставит syncNav() после реальной загрузки страницы
        binding.bottomNav.setOnItemSelectedListener { item ->
            navigateTo(item.itemId)
            false
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    binding.drawerLayout.isDrawerOpen(GravityCompat.START) ->
                        binding.drawerLayout.closeDrawer(GravityCompat.START)
                    // Сначала пусть страница сама обработает «Назад»
                    // (закрыть окно/редактор/поиск, подняться на папку выше)
                    else -> binding.webview.evaluateJavascript(
                        "(function(){try{return !!(window.__onBack&&window.__onBack())}catch(e){return false}})()"
                    ) { result ->
                        if (result != "true") goBackOrExit(this)
                    }
                }
            }
        })

        initWebView(savedInstanceState)
    }

    // Боковое меню рисуется на всю высоту экрана, в том числе под статус-баром.
    // Чтобы статус-бар не перекрывал логотип и название, добавляем к шапке верхний отступ
    // на высоту статус-бара (через insets, а если они не пришли — берём из окна напрямую).
    private var headerBasePaddingTop = -1
    private var footerBasePaddingBottom = -1

    private fun setupDrawerHeaderInsets() {
        val header = binding.navView.getHeaderView(0) ?: return
        headerBasePaddingTop = header.paddingTop
        // Нижняя подпись меню не должна уходить под навигационную панель
        footerBasePaddingBottom = binding.drawerFooter.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(binding.drawerPanel) { _, insets ->
            setFooterBottomInset(insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
            insets // не поглощаем — NavigationView внутри тоже должен получить отступы
        }
        ViewCompat.setOnApplyWindowInsetsListener(header) { _, insets ->
            setHeaderTopInset(insets.getInsets(WindowInsetsCompat.Type.statusBars()).top)
            insets
        }
        header.post { applyDrawerHeaderInset() }
    }

    private fun applyDrawerHeaderInset() {
        val insets = ViewCompat.getRootWindowInsets(binding.root) ?: return
        setHeaderTopInset(insets.getInsets(WindowInsetsCompat.Type.statusBars()).top)
        setFooterBottomInset(insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
    }

    private fun setFooterBottomInset(bottom: Int) {
        val footer = binding.drawerFooter
        if (footerBasePaddingBottom < 0) footerBasePaddingBottom = footer.paddingBottom
        val want = footerBasePaddingBottom + bottom
        if (footer.paddingBottom != want) footer.updatePadding(bottom = want)
    }

    private fun setHeaderTopInset(top: Int) {
        val header = binding.navView.getHeaderView(0) ?: return
        if (headerBasePaddingTop < 0) headerBasePaddingTop = header.paddingTop
        val want = headerBasePaddingTop + top
        if (header.paddingTop != want) header.updatePadding(top = want)
    }

    override fun onPause() {
        if (!operationRunning) {
            binding.webview.onPause()
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.webview.onResume()
    }

    override fun onDestroy() {
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        binding.webview.removeJavascriptInterface("AndroidInterface")
        try { httpExecutor.shutdownNow() } catch (_: Exception) { }
        try {
            (binding.webview.parent as? ViewGroup)?.removeView(binding.webview)
            binding.webview.destroy()
        } catch (_: Exception) { }
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webview.saveState(outState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWebView(savedState: Bundle?) {
        val webView = binding.webview
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            // Страницы уже тёмные (палитра OR Chat) — автоматическое затемнение отключено (API 29+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                @Suppress("DEPRECATION")
                forceDark = WebSettings.FORCE_DARK_OFF
            }
        }
        webView.setBackgroundColor(0xFF101418.toInt())

        // https-origin для assets — иначе fetch к api.github.com даёт "Failed to fetch" (CORS с file://)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val uri = request?.url ?: return super.shouldInterceptRequest(view, request)
                return assetLoader.shouldInterceptRequest(uri)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                return when {
                    url.startsWith("https://appassets.androidplatform.net/") -> false
                    url.startsWith("file:///android_asset/") -> false
                    url.startsWith("http://") || url.startsWith("https://") -> {
                        openExternal(url)
                        true
                    }
                    else -> false
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                supportActionBar?.title = when (pageItemId(url)) {
                    R.id.nav_files -> getString(R.string.files_title)
                    R.id.nav_unzip -> getString(R.string.unzip_title)
                    R.id.nav_tokens -> getString(R.string.tokens_title)
                    else -> getString(R.string.repos_title)
                }
                syncNav(url)
                updateHeaderRepo()
            }

            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?
            ): Boolean {
                // Процесс рендера умер: WebView использовать нельзя, пересоздаём Activity
                resetBusyState()
                Toast.makeText(this@MainActivity, getString(R.string.webview_crashed), Toast.LENGTH_SHORT).show()
                if (!isFinishing && !isDestroyed) recreate()
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.load_error, error?.description?.toString() ?: ""),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.pageProgress.progress = newProgress
                binding.pageProgress.visibility = if (newProgress in 0..99) View.VISIBLE else View.GONE
            }

            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                if (isFinishing || isDestroyed) {
                    result?.cancel()
                    return true
                }
                MaterialAlertDialogBuilder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(R.string.ok) { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = fileChooserParams?.createIntent()
                if (intent == null) {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    return false
                }
                try {
                    fileChooserLauncher.launch(intent)
                } catch (e: Exception) {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    Toast.makeText(this@MainActivity, getString(R.string.file_chooser_error), Toast.LENGTH_SHORT).show()
                    return false
                }
                return true
            }
        }

        webView.addJavascriptInterface(WebAppInterface(), "AndroidInterface")
        if (savedState != null && webView.restoreState(savedState) != null) {
            return
        }
        webView.loadUrl(HOME_URL)
    }

    override fun onNavigationItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.nav_home, R.id.nav_unzip, R.id.nav_files, R.id.nav_tokens -> navigateTo(item.itemId)
            R.id.nav_refresh -> guardUnsaved {
                confirmIfBusy {
                    resetBusyState()
                    binding.webview.reload()
                }
            }
            R.id.nav_about -> showAboutDialog()
        }
        binding.drawerLayout.closeDrawer(GravityCompat.START)
        return true
    }

    private fun pageItemId(url: String?): Int = when {
        url == null -> R.id.nav_home
        url.contains("/assets/files.html") -> R.id.nav_files
        url.contains("/assets/index.html") -> R.id.nav_unzip
        url.contains("/assets/tokens.html") -> R.id.nav_tokens
        else -> R.id.nav_home
    }

    private fun navigateTo(itemId: Int): Boolean {
        val target = when (itemId) {
            R.id.nav_home -> HOME_URL
            R.id.nav_unzip -> UNZIP_URL
            R.id.nav_files -> FILES_URL
            R.id.nav_tokens -> TOKENS_URL
            else -> return false
        }
        if (pageItemId(binding.webview.url) != itemId) {
            guardUnsaved {
                confirmIfBusy {
                    resetBusyState()
                    binding.webview.loadUrl(target)
                }
            }
        }
        return true
    }

    // Подсвечивает текущий раздел в нижней панели и боковом меню
    private fun syncNav(url: String?) {
        val id = pageItemId(url)
        binding.bottomNav.menu.findItem(id)?.isChecked = true
        binding.navView.setCheckedItem(id)
    }

    // В шапке бокового меню показываем выбранный репозиторий
    private fun updateHeaderRepo() {
        val label = binding.navView.getHeaderView(0)?.findViewById<TextView>(R.id.nav_header_repo) ?: return
        binding.webview.evaluateJavascript(
            "(function(){try{var u=localStorage.getItem('unzipgit_username')||'';" +
                "var r=(localStorage.getItem('unzipgit_repo')||'').split('/')[0];return u&&r?u+'/'+r:''}catch(e){return ''}})()"
        ) { res ->
            val v = res?.removeSurrounding("\"")?.trim() ?: ""
            label.text = if (v.isEmpty() || v == "null") getString(R.string.nav_no_repo) else v
        }
    }

    private fun isFilesPage(): Boolean =
        binding.webview.url?.contains("/assets/files.html") == true

    private fun goBackOrExit(callback: OnBackPressedCallback) {
        if (binding.webview.canGoBack()) {
            binding.webview.goBack()
        } else {
            confirmIfBusy {
                callback.isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
    }

    // На экране «Файлы» спрашиваем подтверждение, если в редакторе есть несохранённые изменения
    private fun guardUnsaved(action: () -> Unit) {
        if (!isFilesPage()) {
            action()
            return
        }
        binding.webview.evaluateJavascript(
            "(function(){try{return !!(window.__hasUnsaved&&window.__hasUnsaved())}catch(e){return false}})()"
        ) { result ->
            if (result == "true") {
                MaterialAlertDialogBuilder(this)
                    .setMessage(R.string.unsaved_message)
                    .setPositiveButton(R.string.unsaved_leave) { _, _ -> action() }
                    .setNegativeButton(R.string.busy_cancel, null)
                    .show()
            } else {
                action()
            }
        }
    }

    // Страница перезагружается — JS уже не сообщит об окончании операции, сбрасываем флаги сами
    private fun resetBusyState() {
        operationRunning = false
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun confirmIfBusy(action: () -> Unit) {
        if (!operationRunning) {
            action()
            return
        }
        MaterialAlertDialogBuilder(this)
            .setMessage(R.string.busy_message)
            .setPositiveButton(R.string.busy_continue) { _, _ -> action() }
            .setNegativeButton(R.string.busy_cancel, null)
            .show()
    }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.no_browser), Toast.LENGTH_SHORT).show()
        }
    }

    private fun showAboutDialog() {
        val ver = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
        } catch (e: Exception) {
            "?"
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.about_title)
            .setMessage("UnzipGit\nВерсия: $ver\n\n${getString(R.string.about_text)}")
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    inner class WebAppInterface {
        @JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun showError(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
            }
        }

        @JavascriptInterface
        fun keepScreenOn(enable: Boolean) {
            operationRunning = enable
            runOnUiThread {
                if (enable) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface
        fun isOnline(): Boolean {
            return try {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                val caps = cm.getNetworkCapabilities(cm.activeNetwork)
                caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            } catch (e: Exception) {
                true
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                packageManager.getPackageInfo(packageName, 0).versionName ?: "3.22"
            } catch (e: Exception) {
                "3.22"
            }
        }

        @JavascriptInterface
        fun openUrl(url: String) {
            runOnUiThread {
                openExternal(url)
            }
        }

        /**
         * Сохранение файла на устройство: показывает системное окно «Сохранить как…».
         * base64 — содержимое файла в кодировке Base64.
         */
        @JavascriptInterface
        fun saveFile(fileName: String, mime: String, base64: String) {
            val bytes = try {
                android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            } catch (e: Exception) {
                null
            }
            if (bytes == null) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, getString(R.string.file_save_error), Toast.LENGTH_SHORT).show()
                }
                return
            }
            pendingSave = bytes
            val safeName = fileName.replace('/', '_').ifBlank { "file" }
            runOnUiThread {
                try {
                    saveLauncher.launch(safeName)
                } catch (e: Exception) {
                    pendingSave = null
                    Toast.makeText(this@MainActivity, getString(R.string.file_save_unavailable), Toast.LENGTH_SHORT).show()
                }
            }
        }

        @JavascriptInterface
        fun shareText(text: String, title: String) {
            runOnUiThread {
                try {
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                        putExtra(Intent.EXTRA_SUBJECT, title)
                    }
                    startActivity(Intent.createChooser(send, title))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, getString(R.string.no_browser), Toast.LENGTH_SHORT).show()
                }
            }
        }

        /**
         * Нативный HTTP для обхода CORS в WebView.
         * requestJson: {"url","method","headers":{},"body":"optional string"}
         * Возвращает JSON: {"ok","status","statusText","headers":{},"body":"...","isBase64":bool}
         */
        @JavascriptInterface
        fun httpRequest(requestJson: String): String {
            return try {
                val future = httpExecutor.submit<String> {
                    httpRequestSync(requestJson)
                }
                try {
                    future.get(125, TimeUnit.SECONDS)
                } catch (e: Exception) {
                    future.cancel(true)
                    throw e
                }
            } catch (e: Exception) {
                JSONObject().apply {
                    put("ok", false)
                    put("status", 0)
                    put("statusText", e.message ?: "network error")
                    put("headers", JSONObject())
                    put("body", "")
                    put("isBase64", false)
                    put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
                }.toString()
            }
        }

        private fun httpRequestSync(requestJson: String): String {
            return try {
                val req = JSONObject(requestJson)
                val urlStr = req.getString("url")
                val method = req.optString("method", "GET").uppercase()
                val headersJson = req.optJSONObject("headers")
                val bodyStr = if (req.has("body") && !req.isNull("body")) req.getString("body") else null
                val wantBinary = req.optBoolean("binary", false)

                val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 30000
                    readTimeout = 120000
                    doInput = true
                    instanceFollowRedirects = true
                    if (headersJson != null) {
                        val keys = headersJson.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            setRequestProperty(k, headersJson.getString(k))
                        }
                    }
                    if (bodyStr != null && method != "GET" && method != "HEAD") {
                        doOutput = true
                        outputStream.use { os ->
                            os.write(bodyStr.toByteArray(Charsets.UTF_8))
                        }
                    }
                }

                // Ошибка соединения (таймаут, нет сети) должна попасть во внешний catch
                // и вернуться в JS как status=0 + error, а не как «ответ» со статусом -1
                val status = conn.responseCode
                val statusText = try { conn.responseMessage ?: "" } catch (e: Exception) { "" }
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val bytes = if (stream != null) {
                    BufferedInputStream(stream).use { input ->
                        val buf = ByteArrayOutputStream()
                        val tmp = ByteArray(8192)
                        while (true) {
                            val n = input.read(tmp)
                            if (n <= 0) break
                            buf.write(tmp, 0, n)
                        }
                        buf.toByteArray()
                    }
                } else ByteArray(0)

                val respHeaders = JSONObject()
                conn.headerFields?.forEach { (k, v) ->
                    if (k != null && v != null && v.isNotEmpty()) {
                        respHeaders.put(k, v.joinToString(", "))
                    }
                }

                val bodyOut: String
                val isBase64: Boolean
                // binary=true от JS — всегда base64 (ZIP/raw), иначе эвристика по Content-Type
                if (wantBinary || (conn.contentType?.contains("octet-stream") == true) ||
                    (conn.contentType?.contains("zip") == true) ||
                    (conn.contentType?.startsWith("image/") == true) ||
                    (conn.contentType?.startsWith("application/") == true && conn.contentType?.contains("json") != true)
                ) {
                    bodyOut = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    isBase64 = true
                } else {
                    bodyOut = String(bytes, Charsets.UTF_8)
                    isBase64 = false
                }

                try { conn.disconnect() } catch (_: Exception) { }

                JSONObject().apply {
                    put("ok", status in 200..299)
                    put("status", status)
                    put("statusText", statusText)
                    put("headers", respHeaders)
                    put("body", bodyOut)
                    put("isBase64", isBase64)
                }.toString()
            } catch (e: Exception) {
                JSONObject().apply {
                    put("ok", false)
                    put("status", 0)
                    put("statusText", e.message ?: "network error")
                    put("headers", JSONObject())
                    put("body", "")
                    put("isBase64", false)
                    put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
                }.toString()
            }
        }
    }
}
