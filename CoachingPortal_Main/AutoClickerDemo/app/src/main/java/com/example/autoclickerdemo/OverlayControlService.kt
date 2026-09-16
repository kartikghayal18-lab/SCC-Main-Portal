package com.example.autoclickerdemo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationCompat

class OverlayControlService : Service() {

    companion object {
        const val ACTION_SHOW_OVERLAY = "com.example.autoclickerdemo.SHOW_OVERLAY"
        const val ACTION_HIDE_OVERLAY = "com.example.autoclickerdemo.HIDE_OVERLAY"
        const val EXTRA_INTERVAL_MS = "interval_ms"

        private const val CHANNEL_ID = "auto_click_overlay"
        private const val NOTIFICATION_ID = 1001
    }

    private lateinit var windowManager: WindowManager
    private var overlayView: View? = null
    private var targetView: View? = null
    private var isClicking = false
    private var intervalMs = 500L
    private val handler = Handler(Looper.getMainLooper())

    private val clickLoop = object : Runnable {
        override fun run() {
            if (!isClicking) {
                return
            }

            val target = targetView ?: return
            val location = IntArray(2)
            target.getLocationOnScreen(location)
            val centerX = location[0] + target.width / 2f
            val centerY = location[1] + target.height / 2f

            val service = AutoClickAccessibilityService.instance
            if (service == null) {
                Toast.makeText(
                    applicationContext,
                    R.string.enable_accessibility_first,
                    Toast.LENGTH_SHORT
                ).show()
                stopClicking()
                return
            }

            service.performTap(centerX, centerY)
            handler.postDelayed(this, intervalMs)
        }
    }

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SHOW_OVERLAY -> {
                intervalMs = intent.getLongExtra(EXTRA_INTERVAL_MS, 500L).coerceAtLeast(100L)
                showOverlay()
            }

            ACTION_HIDE_OVERLAY -> {
                removeOverlay()
                stopSelf()
            }
        }

        return START_STICKY
    }

    override fun onDestroy() {
        stopClicking()
        removeOverlay()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun showOverlay() {
        if (overlayView != null) {
            updateOverlayText()
            return
        }

        val inflater = LayoutInflater.from(this)
        overlayView = inflater.inflate(R.layout.overlay_controls, null)
        targetView = overlayView?.findViewById(R.id.tapTarget)

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            } else {
                @Suppress("DEPRECATION")
                WindowManager.LayoutParams.TYPE_PHONE
            },
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 100
            y = 300
        }

        makeDraggable(overlayView!!, params)

        overlayView!!.findViewById<View>(R.id.buttonToggle).setOnClickListener {
            if (isClicking) stopClicking() else startClicking()
        }

        overlayView!!.findViewById<View>(R.id.buttonClose).setOnClickListener {
            stopSelf()
        }

        windowManager.addView(overlayView, params)
        updateOverlayText()
    }

    private fun makeDraggable(view: View, params: WindowManager.LayoutParams) {
        val dragHandle = view.findViewById<View>(R.id.dragHandle)
        dragHandle.setOnTouchListener(object : View.OnTouchListener {
            private var initialX = 0
            private var initialY = 0
            private var initialTouchX = 0f
            private var initialTouchY = 0f

            override fun onTouch(v: View, event: MotionEvent): Boolean {
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = params.x
                        initialY = params.y
                        initialTouchX = event.rawX
                        initialTouchY = event.rawY
                        return true
                    }

                    MotionEvent.ACTION_MOVE -> {
                        params.x = initialX + (event.rawX - initialTouchX).toInt()
                        params.y = initialY + (event.rawY - initialTouchY).toInt()
                        windowManager.updateViewLayout(view, params)
                        return true
                    }
                }
                return false
            }
        })
    }

    private fun startClicking() {
        if (AutoClickAccessibilityService.instance == null) {
            Toast.makeText(this, R.string.enable_accessibility_first, Toast.LENGTH_SHORT).show()
            return
        }
        isClicking = true
        updateOverlayText()
        handler.post(clickLoop)
    }

    private fun stopClicking() {
        isClicking = false
        handler.removeCallbacks(clickLoop)
        updateOverlayText()
    }

    private fun updateOverlayText() {
        val root = overlayView ?: return
        val status = root.findViewById<TextView>(R.id.textStatus)
        val toggle = root.findViewById<TextView>(R.id.buttonToggle)
        status.text = getString(
            if (isClicking) R.string.status_running else R.string.status_idle,
            intervalMs
        )
        toggle.text = getString(if (isClicking) R.string.stop_clicking else R.string.start_clicking)
    }

    private fun removeOverlay() {
        overlayView?.let {
            windowManager.removeView(it)
        }
        overlayView = null
        targetView = null
    }

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_text))
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }
}
