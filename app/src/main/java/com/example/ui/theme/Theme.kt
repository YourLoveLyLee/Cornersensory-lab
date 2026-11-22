package com.example.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val LabDarkColorScheme =
  darkColorScheme(
    primary = LabCrimson,
    secondary = LabGold,
    tertiary = LabGold,
    background = LabBackground,
    surface = LabSurface,
    surfaceVariant = LabSurfaceElevated,
    onPrimary = LabTextPrimary,
    onSecondary = LabBackground,
    onBackground = LabTextPrimary,
    onSurface = LabTextPrimary,
    onSurfaceVariant = LabTextSecondary,
  )

@Composable
fun MyApplicationTheme(content: @Composable () -> Unit) {
  MaterialTheme(colorScheme = LabDarkColorScheme, typography = Typography, content = content)
}
