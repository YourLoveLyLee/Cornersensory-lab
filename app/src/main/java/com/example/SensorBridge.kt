package com.example

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI

class SensorBridge(
  private val context: Context,
  private val webViewProvider: () -> WebView?,
) : SensorEventListener {

  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val mainHandler = Handler(Looper.getMainLooper())

  private val accelSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
  private val linearAccelSensor: Sensor? =
    sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
  private val gyroSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
  private val rotationSensor: Sensor? =
    sensorManager.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
      ?: sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)

  private val lock = Any()
  private var isRunning = false
  private var samplingPeriodUs = 5000 // 200 Hz default

  // Latest state snapshot per sensor so each accel tick can carry latest gyro/orientation
  private var latestAx = 0.0
  private var latestAy = 0.0
  private var latestAz = 0.0
  private var hasAccelSample = false

  private var latestGx = 0.0
  private var latestGy = 0.0
  private var latestGz = 0.0
  private var hasGravAccelSample = false

  private var latestRotAlpha = 0.0
  private var latestRotBeta = 0.0
  private var latestRotGamma = 0.0
  private var hasGyroSample = false

  private var latestOriAlpha = 0.0
  private var latestOriBeta = 0.0
  private var latestOriGamma = 0.0
  private var hasOriSample = false

  private val rotationMatrix = FloatArray(9)
  private val orientationAngles = FloatArray(3)

  private data class SampleFrame(
    val tMs: Double,
    val ax: Double?,
    val ay: Double?,
    val az: Double?,
    val gx: Double,
    val gy: Double,
    val gz: Double,
    val rotAlpha: Double?,
    val rotBeta: Double?,
    val rotGamma: Double?,
    val oriAlpha: Double?,
    val oriBeta: Double?,
    val oriGamma: Double?,
  )

  private val pendingFrames = ArrayList<SampleFrame>(64)

  private val flushRunnable =
    object : Runnable {
      override fun run() {
        val batch: List<SampleFrame>
        synchronized(lock) {
          if (!isRunning) return
          if (pendingFrames.isEmpty()) {
            mainHandler.postDelayed(this, 16L)
            return
          }
          batch = ArrayList(pendingFrames)
          pendingFrames.clear()
        }

        val jsonArray = JSONArray()
        for (f in batch) {
          val obj = JSONObject()
          obj.put("t", f.tMs)
          if (f.ax != null && f.ay != null && f.az != null) {
            obj.put("ax", f.ax)
            obj.put("ay", f.ay)
            obj.put("az", f.az)
          }
          obj.put("gx", f.gx)
          obj.put("gy", f.gy)
          obj.put("gz", f.gz)
          if (f.rotAlpha != null && f.rotBeta != null && f.rotGamma != null) {
            obj.put("ra", f.rotAlpha)
            obj.put("rb", f.rotBeta)
            obj.put("rg", f.rotGamma)
          }
          if (f.oriAlpha != null && f.oriBeta != null && f.oriGamma != null) {
            obj.put("oa", f.oriAlpha)
            obj.put("ob", f.oriBeta)
            obj.put("og", f.oriGamma)
          }
          jsonArray.put(obj)
        }

        val payload = jsonArray.toString()
        webViewProvider()?.evaluateJavascript(
          "if(window.__onAndroidSensorBatch){window.__onAndroidSensorBatch($payload);}",
          null,
        )

        synchronized(lock) {
          if (isRunning) {
            mainHandler.postDelayed(this, 16L)
          }
        }
      }
    }

  @JavascriptInterface
  fun getCapabilitiesJson(): String {
    val root = JSONObject()
    root.put("platform", "Android")
    root.put("manufacturer", Build.MANUFACTURER)
    root.put("model", Build.MODEL)
    root.put("sdkInt", Build.VERSION.SDK_INT)

    root.put("hasAccelerometer", accelSensor != null)
    root.put("hasLinearAcceleration", linearAccelSensor != null)
    root.put("hasGyroscope", gyroSensor != null)
    root.put("hasRotationVector", rotationSensor != null)

    accelSensor?.let { root.put("accelerometerInfo", sensorMetaJson(it)) }
    linearAccelSensor?.let { root.put("linearAccelInfo", sensorMetaJson(it)) }
    gyroSensor?.let { root.put("gyroscopeInfo", sensorMetaJson(it)) }
    rotationSensor?.let { root.put("rotationInfo", sensorMetaJson(it)) }

    return root.toString()
  }

  private fun sensorMetaJson(sensor: Sensor): JSONObject {
    val maxHz = if (sensor.minDelay > 0) (1_000_000.0 / sensor.minDelay) else 0.0
    return JSONObject().apply {
      put("name", sensor.name)
      put("vendor", sensor.vendor)
      put("maxRange", sensor.maximumRange.toDouble())
      put("resolution", sensor.resolution.toDouble())
      put("minDelayUs", sensor.minDelay)
      put("maxHz", maxHz)
    }
  }

  @JavascriptInterface
  fun start(rateHz: Int): Boolean {
    val clampedHz = rateHz.coerceIn(20, 200)
    val periodUs = 1_000_000 / clampedHz
    mainHandler.post {
      startInternal(periodUs)
    }
    return accelSensor != null || linearAccelSensor != null
  }

  private fun startInternal(periodUs: Int) {
    stopInternal()
    synchronized(lock) {
      samplingPeriodUs = periodUs
      pendingFrames.clear()
      isRunning = true
    }

    accelSensor?.let { sensorManager.registerListener(this, it, periodUs) }
    linearAccelSensor?.let { sensorManager.registerListener(this, it, periodUs) }
    gyroSensor?.let { sensorManager.registerListener(this, it, periodUs) }
    rotationSensor?.let { sensorManager.registerListener(this, it, periodUs) }

    mainHandler.postDelayed(flushRunnable, 16L)
  }

  @JavascriptInterface
  fun stop() {
    mainHandler.post {
      stopInternal()
    }
  }

  fun stopInternal() {
    synchronized(lock) {
      isRunning = false
      pendingFrames.clear()
    }
    mainHandler.removeCallbacks(flushRunnable)
    sensorManager.unregisterListener(this)
  }

  @JavascriptInterface
  fun setKeepScreenOn(enabled: Boolean) {
    mainHandler.post {
      webViewProvider()?.keepScreenOn = enabled
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    val tMs = event.timestamp / 1_000_000.0
    val radToDeg = 180.0 / PI

    synchronized(lock) {
      if (!isRunning) return

      when (event.sensor.type) {
        Sensor.TYPE_LINEAR_ACCELERATION -> {
          latestAx = event.values[0].toDouble()
          latestAy = event.values[1].toDouble()
          latestAz = event.values[2].toDouble()
          hasAccelSample = true
          // Primary trigger if linear acceleration exists
          emitFrameLocked(tMs)
        }
        Sensor.TYPE_ACCELEROMETER -> {
          latestGx = event.values[0].toDouble()
          latestGy = event.values[1].toDouble()
          latestGz = event.values[2].toDouble()
          hasGravAccelSample = true
          // If hardware lacks TYPE_LINEAR_ACCELERATION, emit on TYPE_ACCELEROMETER
          if (linearAccelSensor == null) {
            emitFrameLocked(tMs)
          }
        }
        Sensor.TYPE_GYROSCOPE -> {
          // Match Web DeviceMotionEvent.rotationRate convention (deg/s):
          // alpha = Z axis rotation, beta = X axis rotation, gamma = Y axis rotation
          latestRotBeta = event.values[0].toDouble() * radToDeg
          latestRotGamma = event.values[1].toDouble() * radToDeg
          latestRotAlpha = event.values[2].toDouble() * radToDeg
          hasGyroSample = true
          if (accelSensor == null && linearAccelSensor == null) {
            emitFrameLocked(tMs)
          }
        }
        Sensor.TYPE_GAME_ROTATION_VECTOR,
        Sensor.TYPE_ROTATION_VECTOR -> {
          SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
          SensorManager.getOrientation(rotationMatrix, orientationAngles)
          // azimuth (Z), pitch (X), roll (Y) in degrees
          latestOriAlpha = ((orientationAngles[0] * radToDeg) + 360.0) % 360.0
          latestOriBeta = orientationAngles[1] * radToDeg
          latestOriGamma = orientationAngles[2] * radToDeg
          hasOriSample = true
        }
      }
    }
  }

  private fun emitFrameLocked(tMs: Double) {
    if (!hasGravAccelSample && !hasAccelSample && !hasGyroSample) return
    if (pendingFrames.size > 200) {
      pendingFrames.removeAt(0)
    }
    pendingFrames.add(
      SampleFrame(
        tMs = tMs,
        ax = if (hasAccelSample) latestAx else null,
        ay = if (hasAccelSample) latestAy else null,
        az = if (hasAccelSample) latestAz else null,
        gx = latestGx,
        gy = latestGy,
        gz = latestGz,
        rotAlpha = if (hasGyroSample) latestRotAlpha else null,
        rotBeta = if (hasGyroSample) latestRotBeta else null,
        rotGamma = if (hasGyroSample) latestRotGamma else null,
        oriAlpha = if (hasOriSample) latestOriAlpha else null,
        oriBeta = if (hasOriSample) latestOriBeta else null,
        oriGamma = if (hasOriSample) latestOriGamma else null,
      )
    )
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
    // No-op; sensor accuracy changes don't interrupt stream
  }
}
