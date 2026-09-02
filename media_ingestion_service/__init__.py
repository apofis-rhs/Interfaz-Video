"""
Módulo de ingesta de media de Qualidot.

Alcance actual: generación de sesiones de subida resumible a GCS para que el
navegador suba video directo al bucket, sin pasar por este microservicio.
Fases posteriores (tracking en Supabase, chunking, notificación de subida
completa, importación desde proveedores cloud) se agregan como submódulos
separados.
"""
