package com.example

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.example.ui.theme.LabBackground
import com.example.ui.theme.MyApplicationTheme
import java.io.IOException
import java.nio.charset.StandardCharsets

class MainActivity : ComponentActivity() {

  private var webViewRef: WebView? = null
  private lateinit var sensorBridge: SensorBridge

  private var pendingExportContent: String? = null

  private val createDocumentLauncher =
    registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
      val content = pendingExportContent
      pendingExportContent = null
      if (uri != null && content != null) {
        try {
          contentResolver.openOutputStream(uri)?.use { stream ->
            stream.write(content.toByteArray(StandardCharsets.UTF_8))
          }
          notifyExportResult(true, "Saved to device storage")
        } catch (e: IOException) {
          notifyExportResult(false, e.localizedMessage ?: "Failed to write file")
        }
      } else {
        notifyExportResult(false, "Export cancelled")
      }
    }

  private fun notifyExportResult(success: Boolean, message: String) {
    val safeMsg = message.replace("'", "\\'")
    webViewRef?.post {
      webViewRef?.evaluateJavascript(
        "if(window.__onAndroidExportResult){window.__onAndroidExportResult($success,'$safeMsg');}",
        null,
      )
    }
  }

  inner class ExportBridge {
    @JavascriptInterface
    fun saveFile(filename: String, mimeType: String, content: String) {
      runOnUiThread {
        pendingExportContent = content
        try {
          createDocumentLauncher.launch(filename)
        } catch (e: Exception) {
          pendingExportContent = null
          notifyExportResult(false, e.localizedMessage ?: "Cannot open file picker")
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )

    sensorBridge = SensorBridge(applicationContext) { webViewRef }

    setContent {
      MyApplicationTheme {
        CornerSenseWebContainer(
          sensorBridge = sensorBridge,
          exportBridge = remember { ExportBridge() },
          onWebViewCreated = { webView -> webViewRef = webView },
        )
      }
    }
  }

  override fun onPause() {
    super.onPause()
    sensorBridge.stopInternal()
    webViewRef?.evaluateJavascript(
      "if(window.__onAndroidLifecyclePause){window.__onAndroidLifecyclePause();}",
      null,
    )
  }

  override fun onDestroy() {
    sensorBridge.stopInternal()
    webViewRef?.destroy()
    webViewRef = null
    super.onDestroy()
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun CornerSenseWebContainer(
  sensorBridge: SensorBridge,
  exportBridge: MainActivity.ExportBridge,
  onWebViewCreated: (WebView) -> Unit,
) {
  var canGoBack by remember { mutableStateOf(false) }
  var webViewState by remember { mutableStateOf<WebView?>(null) }

  BackHandler(enabled = canGoBack) { webViewState?.goBack() }

  Box(
    modifier =
      Modifier.fillMaxSize().background(LabBackground).windowInsetsPadding(WindowInsets.safeDrawing)
  ) {
    AndroidView(
      modifier = Modifier.fillMaxSize(),
      factory = { context ->
        WebView(context).apply {
          setBackgroundColor(Color.parseColor("#080A0F"))
          keepScreenOn = true
          isVerticalScrollBarEnabled = true
          isHorizontalScrollBarEnabled = false

          settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_DEFAULT
          }

          addJavascriptInterface(sensorBridge, "AndroidSensors")
          addJavascriptInterface(exportBridge, "AndroidExport")

          webChromeClient =
            object : WebChromeClient() {
              override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
              }
            }

          webViewClient =
            object : WebViewClient() {
              override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
              ): WebResourceResponse? {
                val url = request?.url ?: return null
                if (url.host != "cornersense.local") return null

                var path = url.path?.trimStart('/') ?: ""
                if (path.isEmpty() || path == "/") {
                  path = "index.html"
                }

                // Prevent directory traversal outside assets/www
                if (path.contains("..")) return null

                return try {
                  val assetStream = context.assets.open("www/$path")
                  val mimeType =
                    when {
                      path.endsWith(".html") -> "text/html"
                      path.endsWith(".css") -> "text/css"
                      path.endsWith(".js") -> "application/javascript"
                      path.endsWith(".json") -> "application/json"
                      path.endsWith(".svg") -> "image/svg+xml"
                      path.endsWith(".png") -> "image/png"
                      else -> "application/octet-stream"
                    }
                  WebResourceResponse(mimeType, "UTF-8", assetStream)
                } catch (_: IOException) {
                  null
                }
              }

              override fun onPageFinished(view: WebView?, url: String?) {
                canGoBack = view?.canGoBack() == true
              }
            }

          loadUrl("https://cornersense.local/index.html")
          webViewState = this
          onWebViewCreated(this)
        }
      },
      update = { webView -> canGoBack = webView.canGoBack() },
    )
  }
}
