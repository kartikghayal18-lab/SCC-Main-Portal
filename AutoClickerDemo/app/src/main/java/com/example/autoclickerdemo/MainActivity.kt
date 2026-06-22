package com.example.autoclickerdemo

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.example.autoclickerdemo.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.buttonOverlayPermission.setOnClickListener {
            requestOverlayPermission()
        }

        binding.buttonAccessibilitySettings.setOnClickListener {
            openAccessibilitySettings()
        }

        binding.buttonStartOverlay.setOnClickListener {
            if (!Settings.canDrawOverlays(this)) {
                Toast.makeText(this, R.string.overlay_permission_needed, Toast.LENGTH_SHORT).show()
                requestOverlayPermission()
                return@setOnClickListener
            }

            val intervalMs = binding.inputInterval.text.toString().toLongOrNull()?.coerceAtLeast(100L) ?: 500L
            val intent = Intent(this, OverlayControlService::class.java).apply {
                action = OverlayControlService.ACTION_SHOW_OVERLAY
                putExtra(OverlayControlService.EXTRA_INTERVAL_MS, intervalMs)
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
        }

        binding.buttonStopOverlay.setOnClickListener {
            startService(
                Intent(this, OverlayControlService::class.java).apply {
                    action = OverlayControlService.ACTION_HIDE_OVERLAY
                }
            )
        }
    }

    private fun requestOverlayPermission() {
        if (Settings.canDrawOverlays(this)) {
            Toast.makeText(this, R.string.overlay_permission_already_granted, Toast.LENGTH_SHORT).show()
            return
        }

        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:$packageName")
        )
        startActivity(intent)
    }

    private fun openAccessibilitySettings() {
        try {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.accessibility_settings_failed, Toast.LENGTH_SHORT).show()
        }
    }
}
